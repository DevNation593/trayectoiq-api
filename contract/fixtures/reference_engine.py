"""Motor de referencia del Pricing Engine v1.0.0 (aritmetica racional exacta).

Implementa literalmente 03_PRICING_ENGINE.md. No es codigo de produccion: existe
para generar y verificar los fixtures de forma reproducible e independiente de
la implementacion TypeScript.

Uso:
    python reference_engine.py --check   # verifica golden + invalid (exit 1 si difiere)
    python reference_engine.py --write   # recalcula "expected" en el golden
"""
import copy
import json
import pathlib
import re
import sys
from fractions import Fraction as F

HERE = pathlib.Path(__file__).parent
GOLDEN = HERE / "pricing-engine-golden.json"
INVALID = HERE / "pricing-engine-invalid.json"

RAW_PLACES = 10
MAX_RATE_SUM = F("0.90")
MAX_WAITING_SECONDS = 10800
MAX_ROUTE_VALUE = 2147483647  # entero de 32 bits: columnas int de quotes


class PricingError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def num(value):
    """Convierte un string decimal (o entero) en fraccion exacta. None -> None."""
    return None if value is None else F(str(value))


def half_up(x, places):
    """Redondeo HALF_UP (empates se alejan de cero) a `places` decimales, como string."""
    scale = 10 ** places
    scaled = abs(x) * scale
    integer = (scaled.numerator * 2 + scaled.denominator) // (scaled.denominator * 2)
    sign = "-" if x < 0 and integer != 0 else ""
    if places == 0:
        return f"{sign}{integer}"
    return f"{sign}{integer // scale}.{integer % scale:0{places}d}"


def ceil_step(x, step):
    """Menor multiplo de `step` que es >= x, exacto."""
    return -((-x) // step) * step


def validate(route, quote, profile):
    """Reglas de 03_PRICING_ENGINE.md seccion 14, en orden. Lanza la primera que falle."""
    if route["tripDistanceMeters"] <= 0 or route["tripDurationSeconds"] <= 0:
        raise PricingError("PRICING_INVALID_ROUTE")
    if route["pickupDistanceMeters"] < 0 or route["pickupDurationSeconds"] < 0:
        raise PricingError("PRICING_INVALID_ROUTE")
    if any(value > MAX_ROUTE_VALUE for value in route.values()):
        raise PricingError("PRICING_INVALID_ROUTE")
    if not 0 <= quote["waitingSeconds"] <= MAX_WAITING_SECONDS:
        raise PricingError("PRICING_INVALID_ROUTE")
    if not 0 <= num(quote["emptyReturnProbability"]) <= 1:
        raise PricingError("PRICING_INVALID_PROBABILITY")

    money = [quote["tollsAmount"], quote["parkingAmount"], quote["otherDirectCostAmount"],
             profile["fuelPricePerGallon"], profile["tireSetCost"], profile["currentVehicleValue"],
             profile["expectedResidualValue"], profile["monthlyFixedCost"], profile["targetHourlyIncome"],
             profile["paymentFixedFee"]]
    money += [item["cost"] for item in profile["maintenanceItems"]]
    if quote["offeredPrice"] is not None:
        money.append(quote["offeredPrice"])
    if any(num(value) < 0 for value in money):
        raise PricingError("PRICING_NEGATIVE_AMOUNT")

    def positive(value):
        return value is not None and num(value) > 0

    if not positive(profile["fuelEfficiencyKmPerGallon"]):
        raise PricingError("PRICING_DIVISOR_ZERO")
    if any(item["enabled"] and not positive(item["intervalKm"]) for item in profile["maintenanceItems"]):
        raise PricingError("PRICING_DIVISOR_ZERO")
    if num(profile["tireSetCost"]) > 0 and not positive(profile["tireUsefulLifeKm"]):
        raise PricingError("PRICING_DIVISOR_ZERO")
    if num(profile["currentVehicleValue"]) > num(profile["expectedResidualValue"]) \
            and not positive(profile["remainingUsefulLifeKm"]):
        raise PricingError("PRICING_DIVISOR_ZERO")
    if num(profile["monthlyFixedCost"]) > 0 and not positive(profile["expectedMonthlyKm"]):
        raise PricingError("PRICING_DIVISOR_ZERO")

    rates = [num(profile[k]) for k in ("platformCommissionRate", "paymentPercentageRate", "targetProfitMargin")]
    if any(not 0 <= rate < 1 for rate in rates):
        raise PricingError("PRICING_INVALID_RATE")
    if sum(rates) >= MAX_RATE_SUM:
        raise PricingError("PRICING_INVALID_RATE_SUM")


def calculate(fixture, config):
    route, quote, profile = fixture["route"], fixture["quote"], fixture["vehicleCostProfile"]
    validate(route, quote, profile)

    dp, dt = F(route["pickupDistanceMeters"], 1000), F(route["tripDistanceMeters"], 1000)
    tp, tt = F(route["pickupDurationSeconds"], 3600), F(route["tripDurationSeconds"], 3600)
    tw, pr = F(quote["waitingSeconds"], 3600), num(quote["emptyReturnProbability"])
    dist = dp + dt + dt * pr  # SYMMETRIC_ESTIMATE: Dr = Dt
    hours = tp + tt + tt * pr + tw  # SYMMETRIC_ESTIMATE: Tr = Tt

    def per_km(cost, divisor):
        return num(cost) / num(divisor) if num(cost) > 0 else F(0)

    costs = {
        "fuel": dist / num(profile["fuelEfficiencyKmPerGallon"]) * num(profile["fuelPricePerGallon"]),
        "maintenance": dist * sum((num(i["cost"]) / num(i["intervalKm"])
                                   for i in profile["maintenanceItems"] if i["enabled"]), F(0)),
        "tires": dist * per_km(profile["tireSetCost"], profile["tireUsefulLifeKm"]),
        "depreciation": dist * per_km(
            max(F(0), num(profile["currentVehicleValue"]) - num(profile["expectedResidualValue"])),
            profile["remainingUsefulLifeKm"]),
        "fixed": dist * per_km(profile["monthlyFixedCost"], profile["expectedMonthlyKm"]),
        "tolls": num(quote["tollsAmount"]),
        "parking": num(quote["parkingAmount"]),
        "other": num(quote["otherDirectCostAmount"]),
    }
    operating = sum(costs.values(), F(0))
    compensation = hours * num(profile["targetHourlyIncome"])
    rate = num(profile["platformCommissionRate"]) + num(profile["paymentPercentageRate"])
    fee, margin = num(profile["paymentFixedFee"]), num(profile["targetProfitMargin"])

    raw = {
        "floor": (operating + fee) / (1 - rate),
        "minimum": (operating + compensation + fee) / (1 - rate),
        "recommended": (operating + compensation + fee) / (1 - rate - margin),
    }
    threshold_step, recommended_step = num(config["thresholdStep"]), num(config["recommendedStep"])
    thresholds = {
        "floor": ceil_step(raw["floor"], threshold_step),
        "minimum": ceil_step(raw["minimum"], threshold_step),
        "recommended": ceil_step(raw["recommended"], recommended_step),
    }

    decision = per_hour = per_km_earned = None
    if quote["offeredPrice"] is not None:
        offer = num(quote["offeredPrice"])
        earnings = offer * (1 - rate) - fee - operating
        per_hour, per_km_earned = earnings / hours, earnings / dist
        decision = ("ACCEPT" if offer >= thresholds["recommended"]
                    else "NEGOTIATE" if offer >= thresholds["minimum"] else "REJECT")

    costs["operating"], costs["targetCompensation"] = operating, compensation

    def raw_str(x):
        return None if x is None else half_up(x, RAW_PLACES)

    def money_str(x):
        return None if x is None else half_up(x, 2)

    return {
        "effectiveDistanceKmRaw": raw_str(dist),
        "effectiveHoursRaw": raw_str(hours),
        "costsRaw": {k: raw_str(v) for k, v in costs.items()},
        "pricesRaw": {k: raw_str(v) for k, v in raw.items()},
        "thresholds": {k: money_str(v) for k, v in thresholds.items()},
        "decision": decision,
        "earningsPerHourRaw": raw_str(per_hour),
        "earningsPerKmRaw": raw_str(per_km_earned),
        "api": {
            "effectiveDistanceMeters": int(half_up(dist * 1000, 0)),
            "effectiveDurationSeconds": int(half_up(hours * 3600, 0)),
            "costs": {k: money_str(v) for k, v in costs.items()},
            "earningsPerHour": money_str(per_hour),
            "earningsPerKm": money_str(per_km_earned),
        },
    }


def set_path(target, path, value):
    """Asigna value en una ruta tipo 'a.b[0].c'."""
    parts = re.findall(r"[^.\[\]]+", path)
    for part in parts[:-1]:
        target = target[int(part)] if part.isdigit() else target[part]
    last = parts[-1]
    target[int(last) if last.isdigit() else last] = value


def main(mode):
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    config, failures = golden["engineConfig"], []
    by_name = {fixture["name"]: fixture for fixture in golden["fixtures"]}

    for fixture in golden["fixtures"]:
        expected = calculate(fixture, config)
        if mode == "--write":
            fixture["expected"] = expected
        elif fixture.get("expected") != expected:
            failures.append(f"golden {fixture['name']}")
    if mode == "--write":
        GOLDEN.write_text(json.dumps(golden, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    invalid = json.loads(INVALID.read_text(encoding="utf-8"))
    for case in invalid["invalidFixtures"]:
        fixture = copy.deepcopy(by_name[invalid["baseFixture"]])
        for path, value in case["overrides"].items():
            set_path(fixture, path, value)
        try:
            calculate(fixture, config)
            got = "NO_ERROR"
        except PricingError as error:
            got = error.code
        if got != case["expectedCode"]:
            failures.append(f"invalid {case['name']}: esperado {case['expectedCode']}, obtenido {got}")

    for failure in failures:
        print("FALLA:", failure)
    print(f"{len(golden['fixtures'])} golden, {len(invalid['invalidFixtures'])} invalid, {len(failures)} fallas")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "--check"))

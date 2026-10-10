import 'reflect-metadata';
import { createApp } from './app.factory.js';
import { APP_ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

const app = await createApp();
const env = app.get<Env>(APP_ENV);
await app.listen(env.port, '0.0.0.0');

// Times what app.setup.spec's test body does: NestFactory.create (lazy Express adapter import) and app.close.
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const t = () => performance.now();
let a = t();
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ConfigModule } = require('@nestjs/config');
const importCore = t() - a;
class Bare {}
Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true })] })(Bare);
const preload = process.argv[2] === 'preload';
let pre = 0;
if (preload) { a = t(); require('@nestjs/platform-express'); pre = t() - a; }
a = t();
const app = await NestFactory.create(Bare, { logger: false });
const create = t() - a;
a = t(); await app.close(); const close = t() - a;
console.log(JSON.stringify({ mode: preload ? 'adapter preloaded' : 'lazy (as in the spec)', importCoreMs: Math.round(importCore), preloadAdapterMs: Math.round(pre), createMs: Math.round(create), closeMs: Math.round(close) }));

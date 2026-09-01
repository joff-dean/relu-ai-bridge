#!/usr/bin/env node
import crypto from 'node:crypto';
const prefix = process.argv[2] === 'connector' ? 'relu_connector_' : 'relu_';
process.stdout.write(`${prefix}${crypto.randomBytes(32).toString('base64url')}\n`);

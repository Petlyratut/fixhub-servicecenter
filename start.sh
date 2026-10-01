#!/bin/sh
cd "$(dirname "$0")"
exec node --no-warnings server.js

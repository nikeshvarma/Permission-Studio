#!/usr/bin/env node
'use strict';
// Prints the CHANGELOG.md section for a version, for GitHub release notes.
// Usage: node tools/release-notes.js v2.0.5   (the leading "v" is optional)
const fs = require('fs');
const path = require('path');
const want = String(process.argv[2] || require('../package.json').version).replace(/^v/, '');
const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const sections = text.split(/^## /m).slice(1);
const hit = sections.find(s => s.startsWith(want + ' ') || s.startsWith(want + '\n') || s.startsWith('[' + want + ']'));
if (!hit) { console.error('No CHANGELOG.md section for ' + want); process.exit(1); }
process.stdout.write(hit.slice(hit.indexOf('\n') + 1).trim() + '\n');

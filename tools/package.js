#!/usr/bin/env node
'use strict';
// Builds dist/<name>-<version>.vsix with nothing but Node.js: no vsce, no npm
// install, no zip tool, so it works offline and on any OS. The layout matches
// what `vsce package` produces. Usage: node tools/package.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');

/** "owner/repo" from package.json's repository, when it is on GitHub; otherwise null. */
function githubRepo(pkg) {
  const r = pkg && pkg.repository;
  const url = String(typeof r === 'string' ? r : (r && r.url) || '').trim();
  const m = /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url)
    || /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(url)
    || /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  return m ? m[1] + '/' + m[2] : null;
}

/**
 * The README as packaged. VS Code's extension page only shows images from
 * https addresses (it refuses files inside the extension), so relative image
 * paths are pointed at the repository's files on GitHub and relative .md links
 * at their GitHub pages, as Microsoft's own packager does. The README in the
 * repository is left as it is, so it still works on GitHub.
 */
function readmeForPackage(text, repo) {
  if (!repo) return text;
  const relative = u => !/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(u);
  const clean = u => u.replace(/^\.\//, '');
  const raw = u => 'https://raw.githubusercontent.com/' + repo + '/HEAD/' + clean(u);
  const blob = u => 'https://github.com/' + repo + '/blob/HEAD/' + clean(u);
  return text
    .replace(/(!\[[^\]]*\]\()(<?)([^)\s>]+)(>?)((?:\s+"[^"]*")?\))/g, (m, a, lt, u, gt, z) => relative(u) ? a + lt + raw(u) + gt + z : m)
    .replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (m, a, q, u) => relative(u) ? a + q + raw(u) + q : m)
    .replace(/(^|[^!])(\[[^\]]*\]\()([^)\s]+)(\))/g, (m, pre, a, u, z) => relative(u) ? pre + a + blob(u) + z : m);
}

/** Which files go in: with images served from GitHub, the README's own screenshots stay out. */
function packagedFiles(files, repo) {
  return repo ? files.filter(f => !f.startsWith('media/readme/')) : files;
}

module.exports = { githubRepo, readmeForPackage, packagedFiles };
if (require.main !== module) return;

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// What goes into the extension: everything VS Code needs at run time, nothing else.
const INCLUDE = ['extension.js', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'src', 'media'];

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(path.join(rel, f), out);
  else out.push(rel.split(path.sep).join('/'));
  return out;
}
const ghRepo = githubRepo(pkg);
const files = packagedFiles(INCLUDE.flatMap(p => walk(p, [])), ghRepo);
const has = f => files.includes(f);
// vsce stores the licence as LICENSE.txt so it gets a content type.
const inVsix = f => 'extension/' + (f === 'LICENSE' ? 'LICENSE.txt' : f);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const repo = pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url);
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
${repo ? `      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${esc(repo)}" />\n` : ''}      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
${has('LICENSE') ? '    <License>extension/LICENSE.txt</License>\n' : ''}${pkg.icon ? `    <Icon>extension/${esc(pkg.icon)}</Icon>\n` : ''}  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
${has('CHANGELOG.md') ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />\n' : ''}${has('LICENSE') ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />\n' : ''}${pkg.icon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />\n` : ''}  </Assets>
</PackageManifest>
`;
const types = [...new Set(files.map(f => (f === 'LICENSE' ? '.txt' : path.extname(f).toLowerCase())).filter(Boolean))];
const MIME = { '.json': 'application/json', '.js': 'application/javascript', '.md': 'text/markdown', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
const contentTypes = '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  types.concat(['.vsixmanifest']).map(e => `<Default Extension="${e}" ContentType="${e === '.vsixmanifest' ? 'text/xml' : MIME[e] || 'application/octet-stream'}"/>`).join('') + '</Types>\n';

// ---------- zip ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
function zip(entries) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8'); const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 }); const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, n, comp); central.push(cen, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cd, end]));
}

const entries = [['[Content_Types].xml', contentTypes], ['extension.vsixmanifest', manifest]]
  .concat(files.map(f => [inVsix(f), f === 'README.md' ? Buffer.from(readmeForPackage(fs.readFileSync(path.join(root, f), 'utf8'), ghRepo), 'utf8') : fs.readFileSync(path.join(root, f))]));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', pkg.name + '-' + pkg.version + '.vsix');
fs.writeFileSync(out, zip(entries));
console.log('Built ' + path.relative(root, out) + ' (' + files.length + ' files, ' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
if (!has('LICENSE')) console.log('Note: no LICENSE file. Add one before publishing publicly (see RELEASING.md).');
if (!ghRepo) console.log('Note: no GitHub "repository" in package.json, so README images will not show on the extension\u2019s page in VS Code. Add your GitHub URL (see RELEASING.md).');
else console.log('README images and links point at https://github.com/' + ghRepo + ' (the repository must be public for VS Code to load them).');

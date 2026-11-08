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
  // The same addresses Microsoft's packager (vsce) writes: github.com/<repo>/raw/HEAD/<path>.
  const raw = u => 'https://github.com/' + repo + '/raw/HEAD/' + clean(u);
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

// ---------- zip (shared with the Excel export: src/util/zip.js) ----------
const { zip } = require('../src/util/zip');

const entries = [['[Content_Types].xml', contentTypes], ['extension.vsixmanifest', manifest]]
  .concat(files.map(f => [inVsix(f), f === 'README.md' ? Buffer.from(readmeForPackage(fs.readFileSync(path.join(root, f), 'utf8'), ghRepo), 'utf8') : fs.readFileSync(path.join(root, f))]));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', pkg.name + '-' + pkg.version + '.vsix');
fs.writeFileSync(out, zip(entries));
console.log('Built ' + path.relative(root, out) + ' (' + files.length + ' files, ' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
if (!has('LICENSE')) console.log('Note: no LICENSE file. Add one before publishing publicly (see RELEASING.md).');
if (!ghRepo) console.log('Note: no GitHub "repository" in package.json, so README images will not show on the extension\u2019s page in VS Code. Add your GitHub URL (see RELEASING.md).');
else console.log('README images and links point at https://github.com/' + ghRepo + ' (the repository must be public for VS Code to load them).');

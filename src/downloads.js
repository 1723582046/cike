'use strict';
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

async function saveDownload(download, directory) {
  await fs.mkdir(directory, { recursive: true });
  const name = path.basename(download.suggestedFilename().replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '_') || 'download';
  const safeName = name === '.' || name === '..' ? 'download' : name;
  const ext = path.extname(safeName), stem = safeName.slice(0, safeName.length - ext.length);
  // Stage outside the browser's temporary directory. Publish atomically without
  // overwriting another download, even across concurrent environments.
  const staging = await fs.mkdtemp(path.join(directory, '.cike-download-'));
  const temporary = path.join(staging, 'payload');
  try {
    await download.saveAs(temporary);
    for (let index = 0; ; index++) {
      const destination = path.join(directory, index ? `${stem} (${index})${ext}` : safeName);
      try { await fs.link(temporary, destination); return destination; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

function attachDownloads(context, directory = path.join(os.homedir(), 'Downloads'), onError = console.error) {
  const pending = new Set();
  const attached = new WeakSet();
  const attach = page => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('download', download => {
      const task = saveDownload(download, directory).catch(error => onError('下载保存失败：' + error.message));
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
  };
  context.on('page', attach);
  context.pages().forEach(attach);
  return { wait: () => Promise.all([...pending]) };
}
module.exports = { saveDownload, attachDownloads };

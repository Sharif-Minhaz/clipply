import type { ClipplyClient } from '@clipply/ui';

/** ClipplyClient over the preload bridge; all work happens in the main process. */
export const desktopClient: ClipplyClient = {
  list: (f) => window.clipply.list(f),
  subscribe: (cb) => window.clipply.onChanged(cb),
  readThumb: (id) => window.clipply.readThumb(id),
  readBody: (id) => window.clipply.readBody(id),
  openUrl: (id) => window.clipply.openUrl(id),
  linkPreview: (id) => window.clipply.linkPreview(id),
  copy: (id) => window.clipply.copy(id),
  copyText: (text) => window.clipply.copyText(text),
  recognizeText: (id) => window.clipply.recognizeText(id),
  saveFile: (id) => window.clipply.saveFile(id),
  setFlags: (id, flags) => window.clipply.setFlags(id, flags),
  editText: (id, text) => window.clipply.editText(id, text),
  add: (input) => window.clipply.add(input),
  remove: (ids) => window.clipply.remove(ids),
  storage: () => window.clipply.storage(),
  clear: (kinds) => window.clipply.clear(kinds),
};

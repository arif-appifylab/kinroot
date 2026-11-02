import {lazy, Suspense} from 'react';

import type {RichEditorProps} from './rich-editor';

export {EmailPreview, Segmented} from './preview';
export {uploadEmailImage} from './upload';

// The editor (TipTap + ProseMirror) is a separate chunk, loaded when first shown.
const Editor = lazy(() => import('./rich-editor'));

export function RichEditor(props: RichEditorProps) {
  return (
    <Suspense fallback={<div className="animate-pulse rounded-lg border border-input bg-slate-50" style={{minHeight: (props.minHeight ?? (props.compact ? 140 : 260)) + 42}} />}>
      <Editor {...props} />
    </Suspense>
  );
}

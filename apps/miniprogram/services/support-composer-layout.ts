type ComposerLayout = {
  composerFocused: boolean;
  keyboardHeight: number;
  composerLineCount: number;
  composerCapped: boolean;
};

type ComposerPage = {
  data: ComposerLayout & { visible: boolean; atBottom: boolean };
  bottomScrollTop: number;
  composerLayoutRevision: number;
  setData(patch: Partial<ComposerLayout> & { anchor?: string }, rendered?: () => void): void;
};

export function setSupportComposerLayout(page: ComposerPage, patch: Partial<ComposerLayout>): void {
  const revision = ++page.composerLayoutRevision;
  if (!page.data.atBottom) {
    page.setData(patch);
    return;
  }

  // A shorter viewport needs a fresh scroll to the end, while an expanded one
  // may report a smaller scrollTop without the user moving away from the end.
  page.bottomScrollTop = 0;
  page.setData({ ...patch, anchor: "" }, () => {
    if (page.data.visible && page.data.atBottom && page.composerLayoutRevision === revision) {
      page.setData({ anchor: "support-chat-end" });
    }
  });
}

export function updateSupportComposerLines(page: ComposerPage, value: number): void {
  const composerLineCount = Math.max(1, Number(value) || 1);
  const composerCapped = composerLineCount > 4;
  if (composerLineCount !== page.data.composerLineCount || composerCapped !== page.data.composerCapped) {
    setSupportComposerLayout(page, { composerLineCount, composerCapped });
  }
}

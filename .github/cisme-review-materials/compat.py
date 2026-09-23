from pathlib import Path
r=Path.cwd()
p=r/'apps/miniprogram/pages/order-detail/index.wxss';s=p.read_text();assert '.support-sheet button::after{border:0}\n' in s;s=s.replace('.support-sheet button::after{border:0}\n','');p.write_text(s)
p=r/'apps/miniprogram/pages/order-detail/index.wxml';s=p.read_text()
for old,new in [
 ('class="text-button" bindtap="loadSupportSheet"','class="text-button {{sheetLoading?\'text-button--disabled\':\'\'}}" bindtap="loadSupportSheet"'),
 ('<button bindtap="copySheetReturnInstruction"','<button class="{{!sheetCasesReady?\'control--disabled\':\'\'}}" bindtap="copySheetReturnInstruction"'),
 ('class="support-sheet__mode" bindtap="toggleSheetConsulting"','class="support-sheet__mode {{sheetSubmitting||sheetSending||sheetAttempt||sheetSendAttempt?\'control--disabled\':\'\'}}" bindtap="toggleSheetConsulting"')]:
 assert old in s,old;s=s.replace(old,new)
p.write_text(s)
p=r/'tests/unit/native-boundaries.test.ts';s=p.read_text()
old='"expandSupport", "closeSupportSheet", "openFullAftersale", "submitSheetAftersale", "sendSheetMessage"'
new='"expandSupport", "closeSupportSheet", "loadSupportSheet", "copySheetReturnInstruction", "openFullAftersale", "openFullAftersale", "submitSheetAftersale", "toggleSheetConsulting", "sendSheetMessage"'
assert old in s;s=s.replace(old,new);p.write_text(s)

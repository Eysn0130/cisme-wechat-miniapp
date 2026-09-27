# Interrupted native capture

This historical partial capture is bound to Mini Program source SHA-256
`8d89929319e11becde4513f2bcd9e9c687b4bb1dfa38c44393b5a20b728e8558`.
The authenticated local synthetic fixture and WeChat DevTools simulator yielded
six untouched default-route frames before the capture was intentionally stopped.
The finance page had not been captured. A further authority-state defect was
found during review, so the source was changed and this run was not finalized.

The six files are `pages__home__index.png`, `pages__records__index.png`,
`pages__community__index.png`, `pages__profile__index.png`,
`pages__account__index.png`, and `pages__task__index.png` under
`screenshots/raw/`. Their SHA-256 digests are recorded below in that order:

```
a839d61e684187f942298900265adff46e30fc853f917311a53decc0a4de4090
b8395469d61c0ddff218e16f64e53e1b3328f971c1aa07c700430c1f7a4f359c
07e02747f52104adc1589abf3c33a47f51893211844ded7f5597df5926ec0460
248871eecdb75eaf580b2fdb0365dc14195f6b97b038e0bc68d6b2f15d09fccb
6c1dcbd9c55ff8b94a3400c8b847162980287114d23e70edc0f0df0fca64f0ef
2188a316603ecb5710cbe420a3c0fa5b42119fe5aae9f38ee32fd01ecb1ed3ef
```

The generated README and initial SHA256SUMS preceded these frames. This pack
does not provide 40-route health, a completed visual review, any physical-device
result, or current-source acceptance. The later `current-source-acceptance.json`
must refer to the subsequent complete capture, if it succeeds.

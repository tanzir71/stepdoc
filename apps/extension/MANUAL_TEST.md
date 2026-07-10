# Extension manual test

- Load `apps/extension/dist` unpacked in Chrome.
- Start capture; badge is red and increments for clicks, committed inputs, selects, Enter, and navigation.
- Type into email/password fields and verify values never appear in `chrome.storage.local` and pixels are pixelated.
- Click rapidly five times; verify five ordered steps exist.
- Stop with web running and verify the editor opens. Stop without web running and verify `stepdoc-session.json` downloads.
- Cancel and verify pending steps are cleared.

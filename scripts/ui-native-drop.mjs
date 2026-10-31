import assert from 'node:assert/strict';

/** Drive trusted browser drag events, routing through Electron's OOPIF target. */
export async function nativeExplorerDrop({ page, frame, source, target, delay, shiftInside = false, position = { x: .5, y: .5 } }) {
  const main = await page.context().newCDPSession(page);
  let child;
  const from = await source.locator('.label-name').boundingBox();
  const to = await target.boundingBox();
  assert.ok(from && to);
  const start = { x: from.x + Math.min(15, from.width / 2), y: from.y + from.height / 2 };
  const end = { x: to.x + to.width * position.x, y: to.y + to.height * position.y };
  let intercepted;
  main.on('Input.dragIntercepted', event => { intercepted = event.data; });
  const mouse = (type, point, buttons, modifiers = 0) => main.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, modifiers, clickCount: 1 });
  try {
    await main.send('Input.setInterceptDrags', { enabled: true });
    await mouse('mouseMoved', start, 0);
    await mouse('mousePressed', start, 1);
    await mouse('mouseMoved', { x: start.x + 15, y: start.y + 2 }, 1);
    for (let attempt = 0; attempt < 100 && !intercepted; attempt++) await delay(25);
    assert.ok(intercepted, 'Explorer starts a real browser drag');
    assert.ok(intercepted.items.some(item => ['resourceurls', 'codefiles', 'application/vnd.code.uri-list', 'text/uri-list'].includes(item.mimeType)), 'Explorer supplies file resources');
    if (shiftInside) {
      for (const type of ['dragEnter', 'dragOver']) await main.send('Input.dispatchDragEvent', { type, ...end, modifiers: 0, data: intercepted });
      await delay(100);
    }
    await main.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, windowsVirtualKeyCode: 16 });
    for (const type of ['dragEnter', 'dragOver']) await main.send('Input.dispatchDragEvent', { type, ...end, modifiers: 8, data: intercepted });
    await delay(100);
    const receiver = await page.evaluate(({ x, y }) => { const element = document.elementFromPoint(x, y); return { tag: element?.tagName, class: element?.className }; }, end);
    assert.equal(receiver.tag, 'IFRAME', `The editor must release its webview for Shift-drop: ${JSON.stringify(receiver)}`);
    for (let candidate = frame; candidate && candidate !== page.mainFrame(); candidate = candidate.parentFrame()) {
      try { child = await page.context().newCDPSession(candidate); break; } catch { }
    }
    assert.ok(child, 'Electron exposes the webview CDP target');
    const point = await target.evaluate((element, position) => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width * position.x, y: rect.y + rect.height * position.y }; }, position);
    for (const type of ['dragEnter', 'dragOver']) await child.send('Input.dispatchDragEvent', { type, ...point, modifiers: 8, data: intercepted });
    assert.equal(await frame.locator('.terminal-area').evaluate(element => element.classList.contains('file-drop-target')), true, 'The complete terminal area indicates that the drag is accepted');
    if (await target.evaluate(element => element.classList.contains('terminal-footer'))) await frame.locator('.terminal-area').screenshot({ path: `.test-results/terminal-drop-ready-${process.pid}.png` });
    await child.send('Input.dispatchDragEvent', { type: 'drop', ...point, modifiers: 8, data: intercepted });
  } finally {
    // CDP cannot finish an intercepted main-target drag from a child target.
    // End the source only after the target's drop, matching the native order.
    await main.send('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, modifiers: 8, data: intercepted || { items: [], dragOperationsMask: 17 } }).catch(() => {});
    await mouse('mouseReleased', end, 0).catch(() => {});
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0, windowsVirtualKeyCode: 16 }).catch(() => {});
    await main.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    await child?.detach(); await main.detach();
  }
}

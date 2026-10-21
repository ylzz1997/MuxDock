import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const markers = ['CONTRAST_DEFAULT', 'CONTRAST_RGB_BG', 'CONTRAST_DIM_BG', 'CONTRAST_256_BG', 'CONTRAST_ANSI_BG', 'CONTRAST_ANSI_FG', 'CONTRAST_256_FG', 'CONTRAST_RGB_FG'];
const output = [
  '\\033[0mCONTRAST_DEFAULT',
  '\\033[48;2;48;48;48mCONTRAST_RGB_BG',
  '\\033[2mCONTRAST_DIM_BG',
  '\\033[0;48;5;236mCONTRAST_256_BG',
  '\\033[0;40mCONTRAST_ANSI_BG',
  '\\033[0;93;107mCONTRAST_ANSI_FG',
  '\\033[0;38;5;229;48;5;231mCONTRAST_256_FG',
  '\\033[0;38;2;255;224;160;48;2;255;255;255mCONTRAST_RGB_FG',
  '\\033[0m'
].join('\\n');

function contrast(foreground, background) {
  const parse = color => color.match(/[\d.]+/g).map(Number);
  const fg = parse(foreground), bg = parse(background), alpha = fg[3] ?? 1;
  const luminance = channels => channels.slice(0, 3).map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const foregroundLuminance = luminance(fg.slice(0, 3).map((channel, index) => channel * alpha + bg[index] * (1 - alpha)));
  const backgroundLuminance = luminance(bg);
  return (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
}

export async function checkTerminalTheme({ frame, page, cli, until, updateSettings, editor }) {
  const readColors = () => frame.evaluate(markers => {
    const terminal = document.querySelector('.terminal-instance:not([hidden])');
    const spans = [...terminal.querySelectorAll('.xterm-rows span')];
    const colors = {};
    for (const marker of markers) {
      const span = spans.find(element => element.textContent === marker);
      if (!span) return false;
      const style = getComputedStyle(span);
      let background = 'rgba(0, 0, 0, 0)';
      for (let element = span; element && background === 'rgba(0, 0, 0, 0)'; element = element.parentElement) background = getComputedStyle(element).backgroundColor;
      colors[marker] = {
        foreground: style.color,
        background
      };
    }
    return colors;
  }, markers);
  const reports = [];
  const record = async (label, minimum) => {
    const colors = await until(async () => {
      const colors = await readColors();
      if (!colors) return false;
      for (const cell of Object.values(colors)) cell.contrast = contrast(cell.foreground, cell.background);
      return minimum === undefined || Object.entries(colors).every(([marker, cell]) => cell.contrast >= minimum / (marker.includes('_DIM_') ? 2 : 1) - .01) ? colors : false;
    }, 10000);
    reports.push({ label, colors });
    await writeFile(`.test-results/terminal-theme-${editor}.json`, JSON.stringify(reports, null, 2));
    return colors;
  };
  try {
    await updateSettings({ 'workbench.colorTheme': 'Default Light Modern' });
    await until(async () => await frame.locator('body').getAttribute('data-vscode-theme-kind') === 'vscode-light');
    cli(['send-keys', '-t', 'my-project:logs', `printf '${output}\\n'`, 'Enter']);
    // Read once before asserting, so a failing run preserves the actual colors.
    const original = await record('light before assertion');
    await frame.locator('.dock').screenshot({ path: `.test-results/terminal-theme-light-${editor}.png` });
    await record('light default minimum 4.5', 4.5);

    await updateSettings({ 'terminal.integrated.minimumContrastRatio': 1 });
    await until(async () => (await readColors())?.CONTRAST_RGB_BG.foreground === original.CONTRAST_DEFAULT.foreground);
    const disabled = await record('contrast adjustment disabled');
    assert.ok(disabled.CONTRAST_RGB_BG.contrast < 1.5, 'Disabling contrast adjustment must preserve the application colors');
    await updateSettings({ 'terminal.integrated.minimumContrastRatio': 7 });
    await record('contrast setting immediately raised to 7', 7);
    await updateSettings({ 'terminal.integrated.minimumContrastRatio': 4.5 });
    await until(async () => {
      const cell = (await readColors())?.CONTRAST_RGB_BG;
      return cell && contrast(cell.foreground, cell.background) < 7;
    });
    const restored = await record('contrast setting restored to 4.5', 4.5);
    assert.ok(restored.CONTRAST_RGB_BG.contrast < 7, 'Restoring the setting must also lower contrast without reconnecting');

    await updateSettings({ 'workbench.colorTheme': 'Default Dark Modern' });
    await until(async () => await frame.locator('body').getAttribute('data-vscode-theme-kind') === 'vscode-dark');
    await until(async () => (await readColors())?.CONTRAST_DEFAULT.foreground !== original.CONTRAST_DEFAULT.foreground);
    await record('existing terminal switched to dark theme', 4.5);
    await frame.locator('.dock').screenshot({ path: `.test-results/terminal-theme-dark-${editor}.png` });
    await updateSettings({ 'workbench.colorTheme': 'Default Light Modern' });
    await until(async () => await frame.locator('body').getAttribute('data-vscode-theme-kind') === 'vscode-light');
    await until(async () => (await readColors())?.CONTRAST_DEFAULT.foreground === original.CONTRAST_DEFAULT.foreground);
    await record('existing terminal switched back to light theme', 4.5);
    console.log(`${editor} terminal contrast: PASS`);
    return reports;
  } finally {
    await updateSettings({ 'workbench.colorTheme': 'Default Dark Modern', 'terminal.integrated.minimumContrastRatio': 4.5 });
    await until(async () => await frame.locator('body').getAttribute('data-vscode-theme-kind') === 'vscode-dark');
  }
}

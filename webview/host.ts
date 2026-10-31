import { t } from '../src/i18n';
export const nativeTerminal = document.documentElement.dataset.host === 'iterm2';
interface Host<T> { postMessage(message: unknown): void; getState(): T | undefined; setState(state: T): void }
declare const acquireVsCodeApi: <T>() => Host<T>;
export function createHost<T>(): Host<T> {
  if (!nativeTerminal) return acquireVsCodeApi<T>();
  const storageKey = 'muxdock.iterm2.sidebar';
  let socket: WebSocket, disposed = false, dialog: HTMLDialogElement | undefined;
  const status = document.createElement('button'); status.className = 'native-status'; status.hidden = true; status.setAttribute('role', 'status');
  status.addEventListener('click', () => { status.hidden = true; }); document.body.append(status);
  const error = (message: string) => { status.textContent = message; status.hidden = false; };
  const host: Host<T> = {
    postMessage(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); else error(t('itermReconnecting')); },
    getState() { try { return JSON.parse(localStorage.getItem(storageKey) || 'null') || undefined; } catch { return; } },
    setState(state) { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {} }
  };
  function connect() {
    socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${location.pathname}socket`);
    socket.addEventListener('open', () => { status.hidden = true; host.postMessage({ type: 'ready' }); });
    socket.addEventListener('close', () => { dialog?.close(); error(t('itermReconnecting')); if (!disposed) setTimeout(connect, 1500); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'dialog') {
        dialog?.close();
        const active = document.activeElement as HTMLElement | null;
        const box = document.createElement('dialog'); dialog = box; box.className = 'native-dialog';
        const form = document.createElement('form'); form.method = 'dialog';
        const title = document.createElement('h2'); title.textContent = message.title; title.id = 'native-dialog-title'; box.setAttribute('aria-labelledby', title.id); form.append(title);
        if (message.detail) { const detail = document.createElement('p'); detail.id = 'native-dialog-detail'; detail.textContent = message.detail; form.append(detail); }
        let input: HTMLInputElement | HTMLSelectElement | undefined;
        if (message.choices) {
          const select = document.createElement('select');
          for (const choice of message.choices) { const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.label; select.append(option); }
          input = select;
        } else if (!message.confirm) { input = document.createElement('input'); input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off'; }
        if (input) {
          input.setAttribute('aria-label', message.title); if (message.value !== undefined) input.value = message.value; form.append(input);
          const descriptions = message.detail ? ['native-dialog-detail'] : [];
          if (message.choices?.some((choice: { detail?: string }) => choice.detail)) {
            const detail = document.createElement('p'); detail.id = 'native-dialog-choice-detail'; detail.setAttribute('aria-live', 'polite');
            const updateDetail = () => { detail.textContent = message.choices.find((choice: { id: string }) => choice.id === input!.value)?.detail || ''; detail.hidden = !detail.textContent; };
            updateDetail(); input.addEventListener('change', updateDetail); form.append(detail); descriptions.push(detail.id);
          }
          if (descriptions.length) input.setAttribute('aria-describedby', descriptions.join(' '));
        }
        const actions = document.createElement('div'); actions.className = 'native-dialog-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('cancelAction'); cancel.addEventListener('click', () => box.close());
        const accept = document.createElement('button'); accept.type = 'submit'; accept.className = message.confirm ? 'danger primary' : 'primary'; accept.textContent = message.accept || t('confirmAction');
        actions.append(cancel, accept); form.append(actions); box.append(form); document.body.append(box);
        let value: string | undefined;
        form.addEventListener('submit', () => { value = input ? input.value : 'confirm'; });
        box.addEventListener('close', () => { box.remove(); if (dialog === box) dialog = undefined; host.postMessage({ type: 'dialogResult', id: message.id, value }); active?.focus({ preventScroll: true }); });
        box.showModal(); if (input) { input.focus(); if (input instanceof HTMLInputElement) input.select(); } else cancel.focus();
      } else {
        if (message.type === 'error') error(message.message);
        if (message.type === 'nativeConnection') { if (!message.connected) error(t('itermReconnecting')); else status.hidden = true; }
        window.dispatchEvent(new MessageEvent('message', { data: message }));
      }
    });
  }
  window.addEventListener('pagehide', () => { disposed = true; socket?.close(); });
  connect(); return host;
}

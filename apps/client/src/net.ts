import type { ClientMsg, ServerMsg } from '@poprock/shared';

export class Net {
  private ws: WebSocket | null = null;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  constructor(
    private url: string,
    private name: string,
  ) {
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus(true);
      this.send({ t: 'hello', name: this.name });
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = () => {
      this.onStatus(false);
      setTimeout(() => this.open(), 1500);
    };
  }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

export function serverUrl(): string {
  const override = new URLSearchParams(location.search).get('server');
  if (override) return `ws://${override}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

// Propagate a lost HTTP response to the assistant request, including an already closed socket.
export function abortOnResponseClose(response) {
  const controller = new AbortController();
  const onClose = () => { if (!response.writableEnded) controller.abort(); };
  response.on('close', onClose);
  if (response.destroyed) onClose();
  return { signal: controller.signal, dispose: () => response.off('close', onClose) };
}

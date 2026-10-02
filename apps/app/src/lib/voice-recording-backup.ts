const KEY = "pending";

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cloudroom-voice", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("recordings");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = run(db.transaction("recordings", mode).objectStore("recordings"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.transaction?.addEventListener("complete", () => db.close());
    };
  });
}

export const saveVoiceRecording = (file: File) =>
  withStore("readwrite", (store) => store.put(file, KEY)).catch(() => {});

export const loadVoiceRecording = () =>
  withStore<File | undefined>("readonly", (store) => store.get(KEY)).catch(
    () => undefined,
  );

export const clearVoiceRecording = () =>
  withStore("readwrite", (store) => store.delete(KEY)).catch(() => {});

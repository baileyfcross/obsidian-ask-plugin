export async function sha256(
  content: string,
): Promise<string> {
  const encoded =
    new TextEncoder().encode(content);

  return sha256Bytes(encoded);
}

export async function sha256Bytes(
  content:
    | ArrayBuffer
    | Uint8Array,
): Promise<string> {
  const bytes =
    content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

  /*
   * TypeScript models Uint8Array.buffer as ArrayBufferLike,
   * which may include SharedArrayBuffer. Web Crypto's
   * digest() requires BufferSource backed by a plain
   * ArrayBuffer. Copy the bytes into a new ArrayBuffer so
   * the type and runtime value are both unambiguous.
   */
  const buffer =
    new ArrayBuffer(
      bytes.byteLength,
    );

  new Uint8Array(
    buffer,
  ).set(bytes);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      buffer,
    );

  return Array.from(
    new Uint8Array(digest),
  )
    .map((byte) =>
      byte
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
}

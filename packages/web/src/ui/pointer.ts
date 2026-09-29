/** A touch screen's pointer (a finger): the UI says "tap", not "click", and names no keys. */
export const coarsePointer = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

import { Text } from "@react-three/drei";
import { type ComponentProps, forwardRef, Suspense } from "react";

/**
 * drei's `<Text>` inside its own Suspense boundary. The first text in a font suspends while the font loads, and a
 * suspension that reaches the canvas's root is handed up to the page: React hides the whole board (display: none),
 * the frame loop stops and the camera's layout effects are cleaned up. Contained here, only the text waits.
 */
export const BoardText = forwardRef<unknown, ComponentProps<typeof Text>>(function BoardText(props, ref) {
  return (
    <Suspense fallback={null}>
      <Text ref={ref as never} {...props} />
    </Suspense>
  );
});

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { View, PanResponder, Text, Pressable } from "react-native";
import Svg, { Path } from "react-native-svg";
import { captureRef } from "react-native-view-shot";

export interface SignaturePadHandle {
  captureAsPngUri: () => Promise<string>;
  isEmpty: () => boolean;
}

type Point = { x: number; y: number };

function pointsToPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.reduce((acc, p, i) => acc + `${i === 0 ? "M" : "L"}${p.x},${p.y} `, "");
}

export const SignaturePad = forwardRef<SignaturePadHandle, { height?: number }>(function SignaturePad(
  { height = 200 },
  ref,
) {
  const containerRef = useRef<View>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const currentStroke = useRef<Point[]>([]);
  const [, forceRender] = useState(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        currentStroke.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
        forceRender((n) => n + 1);
      },
      onPanResponderMove: (e) => {
        currentStroke.current = [...currentStroke.current, { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
        forceRender((n) => n + 1);
      },
      onPanResponderRelease: () => {
        setStrokes((prev) => [...prev, currentStroke.current]);
        currentStroke.current = [];
      },
    }),
  ).current;

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.length === 0,
    captureAsPngUri: async () => {
      if (!containerRef.current) throw new Error("Signature pad not ready");
      return captureRef(containerRef, { format: "png", quality: 1 });
    },
  }));

  function clear() {
    setStrokes([]);
    currentStroke.current = [];
  }

  return (
    <View>
      <View
        ref={containerRef}
        collapsable={false}
        style={{ height }}
        className="overflow-hidden rounded-xl border border-slate-300 bg-white"
        {...panResponder.panHandlers}
      >
        <Svg width="100%" height="100%">
          {strokes.map((stroke, i) => (
            <Path key={i} d={pointsToPath(stroke)} stroke="#0f172a" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          <Path d={pointsToPath(currentStroke.current)} stroke="#0f172a" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>

      <Pressable onPress={clear} className="mt-2 self-start">
        <Text className="text-sm text-slate-500 underline">Clear</Text>
      </Pressable>
    </View>
  );
});

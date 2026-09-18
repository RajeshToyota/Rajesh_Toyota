import { Component, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Catches render-time crashes anywhere below it (e.g. a malformed response from a Supabase call
// used directly in JSX) so a single bad screen doesn't take down the whole app with a blank
// white screen — the user gets a recoverable error state instead.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <View className="flex-1 items-center justify-center bg-white px-6">
          <Text className="text-center text-base font-medium text-slate-900">Something went wrong</Text>
          <Text className="mt-2 text-center text-sm text-slate-500">{this.state.error.message}</Text>
          <Pressable
            onPress={() => this.setState({ error: null })}
            className="mt-6 rounded-lg bg-slate-900 px-4 py-2"
          >
            <Text className="font-medium text-white">Try Again</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

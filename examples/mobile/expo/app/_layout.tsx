/**
 * ProtoFlow Expo example: every prototype screen is an Expo Router route, so the driver opens it directly with a deep
 * link (`protoflowtasks://<screen>?state=…&fixture=…`, the driver's --launch-url). The prototype draws the content
 * area only: no navigation bar, no transition animation.
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, styles } from '../src/ui';

export default function Layout() {
  return (
    <SafeAreaView style={styles.canvas}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: colors.canvas } }} />
    </SafeAreaView>
  );
}

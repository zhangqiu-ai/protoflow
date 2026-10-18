import React, { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, Header, PrimaryButton, styles } from '../src/ui';

export default function Settings() {
  const router = useRouter();
  const [notify, setNotify] = useState(false);
  const [saved, setSaved] = useState(false);
  // A deep link opens Settings with nothing behind it.
  const back = () => (router.canGoBack() ? router.back() : router.replace('/tasks'));
  return (
    <View testID="settings" style={styles.screen}>
      <Header prefix="settings" title="Settings" action="Back" onPress={back} />
      <View testID="settings.notify" style={styles.row}>
        <Text style={styles.body}>Daily reminder</Text>
        <Switch testID="settings.notify-toggle" value={notify} onValueChange={setNotify} trackColor={{ true: colors.accent, false: colors.track }} />
      </View>
      <PrimaryButton testID="settings.save" title="Save" wide onPress={() => setSaved(true)} />
      {saved && <Text testID="settings.saved" style={styles.saved}>Saved.</Text>}
    </View>
  );
}

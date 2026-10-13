/**
 * ProtoFlow React Native example: the same two screens as ../prototype, anchors as testID.
 * Launch convention: PROTOFLOW_SCREEN opens a screen directly — an initial prop on Android (intent extra, see
 * MainActivity), a launch argument on iOS (read through Settings / NSUserDefaults).
 */
import React, { useState } from 'react';
import { Keyboard, Platform, Pressable, Settings, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const colors = { accent: '#0d766e', ink: '#18323c', canvas: '#f2f5f7', surface: '#ffffff', border: '#d9e2e5', danger: '#ad3f3c', track: '#e9e9eb' };
const iosLaunchScreen = (): string | undefined => (Platform.OS === 'ios' ? Settings.get('PROTOFLOW_SCREEN') : undefined);

function Header({ prefix, title, action, onPress }: { prefix: string; title: string; action: string; onPress: () => void }) {
  return (
    <View testID={`${prefix}.header`} style={styles.header}>
      <Text testID={`${prefix}.title`} style={styles.title}>{title}</Text>
      <Pressable testID={`${prefix}.${action === 'Back' ? 'back' : 'settings'}`} accessibilityRole="button" onPress={onPress}>
        <Text style={styles.link}>{action}</Text>
      </Pressable>
    </View>
  );
}

function PrimaryButton({ testID, title, wide, onPress }: { testID: string; title: string; wide?: boolean; onPress: () => void }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={[styles.button, wide && styles.wide]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function TasksScreen({ open }: { open: (screen: string) => void }) {
  const [items, setItems] = useState(['Review prototype', 'Ship version']);
  const [draft, setDraft] = useState('');
  const [showError, setShowError] = useState(false);
  const add = () => {
    Keyboard.dismiss();
    const text = draft.trim();
    if (!text) { setShowError(true); return; }
    setShowError(false);
    setItems([...items, text]);
    setDraft('');
  };
  return (
    <View testID="tasks" style={styles.screen}>
      <Header prefix="tasks" title="Today" action="Settings" onPress={() => open('settings')} />
      <View testID="tasks.list" style={styles.list}>
        {items.map((item, index) => <Text key={index} testID="tasks.item" style={styles.item}>{item}</Text>)}
      </View>
      <View testID="tasks.form" style={styles.form}>
        <TextInput testID="tasks.input" style={styles.input} placeholder="New task" placeholderTextColor="#a3aeb3" value={draft} onChangeText={setDraft} onSubmitEditing={add} />
        <PrimaryButton testID="tasks.add" title="Add" onPress={add} />
      </View>
      {showError && <Text testID="tasks.error" style={styles.error}>Enter a task first.</Text>}
    </View>
  );
}

function SettingsScreen({ open }: { open: (screen: string) => void }) {
  const [notify, setNotify] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <View testID="settings" style={styles.screen}>
      <Header prefix="settings" title="Settings" action="Back" onPress={() => open('tasks')} />
      <View testID="settings.notify" style={styles.row}>
        <Text style={styles.body}>Daily reminder</Text>
        <Switch testID="settings.notify-toggle" value={notify} onValueChange={setNotify} trackColor={{ true: colors.accent, false: colors.track }} />
      </View>
      <PrimaryButton testID="settings.save" title="Save" wide onPress={() => setSaved(true)} />
      {saved && <Text testID="settings.saved" style={styles.saved}>Saved.</Text>}
    </View>
  );
}

export default function App(props: { PROTOFLOW_SCREEN?: string }) {
  const [screen, setScreen] = useState(props.PROTOFLOW_SCREEN ?? iosLaunchScreen() ?? 'tasks');
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.canvas}>
        {screen === 'settings' ? <SettingsScreen open={setScreen} /> : <TasksScreen open={setScreen} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: colors.canvas },
  screen: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  header: { height: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: colors.ink },
  link: { fontSize: 17, color: colors.accent },
  list: { gap: 8, marginBottom: 16 },
  item: { height: 48, lineHeight: 48, paddingHorizontal: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surface, fontSize: 17, color: colors.ink },
  form: { flexDirection: 'row', gap: 10 },
  input: { flex: 1, height: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, fontSize: 17, backgroundColor: colors.surface, color: colors.ink },
  button: { height: 44, borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center' },
  wide: { alignSelf: 'stretch' },
  buttonText: { color: '#ffffff', fontSize: 17, fontWeight: '600' },
  // Text hugs its content like the prototype's fit-content paragraphs (flex children stretch by default).
  error: { alignSelf: 'flex-start', color: colors.danger, fontSize: 15, marginTop: 12 },
  saved: { alignSelf: 'flex-start', color: colors.accent, fontSize: 15, marginTop: 12 },
  row: { height: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 16, marginBottom: 16 },
  body: { fontSize: 17, color: colors.ink }
});

import React, { useState } from 'react';
import { Keyboard, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Header, PrimaryButton, styles } from '../src/ui';

export default function Tasks() {
  const router = useRouter();
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
      <Header prefix="tasks" title="Today" action="Settings" onPress={() => router.push('/settings')} />
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

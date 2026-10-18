/**
 * Shared pieces of the two screens: the same look as ../prototype, anchors as testID.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = { accent: '#0d766e', ink: '#18323c', canvas: '#f2f5f7', surface: '#ffffff', border: '#d9e2e5', danger: '#ad3f3c', track: '#e9e9eb' };

export function Header({ prefix, title, action, onPress }: { prefix: string; title: string; action: 'Settings' | 'Back'; onPress: () => void }) {
  return (
    <View testID={`${prefix}.header`} style={styles.header}>
      <Text testID={`${prefix}.title`} style={styles.title}>{title}</Text>
      <Pressable testID={`${prefix}.${action === 'Back' ? 'back' : 'settings'}`} accessibilityRole="button" onPress={onPress}>
        <Text style={styles.link}>{action}</Text>
      </Pressable>
    </View>
  );
}

export function PrimaryButton({ testID, title, wide, onPress }: { testID: string; title: string; wide?: boolean; onPress: () => void }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={[styles.button, wide && styles.wide]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: colors.canvas },
  screen: { flex: 1, paddingHorizontal: 20, paddingTop: 16, backgroundColor: colors.canvas },
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

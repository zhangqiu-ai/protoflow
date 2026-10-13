/**
 * The app's own functional tests (ProtoFlow `functional` for the react-native target).
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import App from '../App';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
// Launch arguments come from NSUserDefaults on device; tests start on the default screen.
jest.mock('react-native/Libraries/Settings/Settings', () => ({ __esModule: true, default: { get: () => undefined, set: jest.fn(), watchKeys: jest.fn(), clearWatch: jest.fn() } }));

const host = (root: ReactTestRenderer.ReactTestInstance, testID: string) =>
  root.findAll(node => node.props.testID === testID && typeof node.type === 'string');

async function render() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { renderer = ReactTestRenderer.create(<App />); });
  return renderer.root;
}

test('adding a task appends it and clears the field', async () => {
  const root = await render();
  await act(async () => host(root, 'tasks.input')[0].props.onChangeText('Write tests'));
  await act(async () => root.findByProps({ testID: 'tasks.add' }).props.onPress());
  expect(host(root, 'tasks.item').map(item => item.props.children)).toEqual(['Review prototype', 'Ship version', 'Write tests']);
  expect(host(root, 'tasks.error')).toHaveLength(0);
  expect(host(root, 'tasks.input')[0].props.value).toBe('');
});

test('adding an empty task shows the error', async () => {
  const root = await render();
  await act(async () => root.findByProps({ testID: 'tasks.add' }).props.onPress());
  expect(host(root, 'tasks.error')).toHaveLength(1);
  expect(host(root, 'tasks.item')).toHaveLength(2);
});

test('settings can be saved and closed', async () => {
  const root = await render();
  await act(async () => root.findByProps({ testID: 'tasks.settings' }).props.onPress());
  await act(async () => root.findByProps({ testID: 'settings.notify-toggle' }).props.onValueChange(true));
  await act(async () => root.findByProps({ testID: 'settings.save' }).props.onPress());
  expect(host(root, 'settings.saved')).toHaveLength(1);
  await act(async () => root.findByProps({ testID: 'settings.back' }).props.onPress());
  expect(host(root, 'tasks.title')).toHaveLength(1);
});

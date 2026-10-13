import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/semantics.dart';

/// ProtoFlow launch convention: the native side reads PROTOFLOW_SCREEN (iOS launch argument, Android intent extra)
/// and returns it over this channel; the app opens that screen directly.
const _launch = MethodChannel('dev.protoflow/launch');

const accent = Color(0xFF0D766E);
const ink = Color(0xFF18323C);
const canvas = Color(0xFFF2F5F7);
const border = Color(0xFFD9E2E5);
const danger = Color(0xFFAD3F3C);
const placeholder = Color(0xFFA3AEB3);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  String? screen;
  try {
    screen = await _launch.invokeMethod<String>('screen');
  } on MissingPluginException {
    screen = null;
  }
  // Anchors are read through the platform accessibility tree, so semantics stay on even without a screen reader.
  SemanticsBinding.instance.ensureSemantics();
  runApp(TasksApp(initial: screen ?? 'tasks'));
}

class TasksApp extends StatefulWidget {
  const TasksApp({super.key, required this.initial});
  final String initial;
  @override
  State<TasksApp> createState() => _TasksAppState();
}

class _TasksAppState extends State<TasksApp> {
  late String screen = widget.initial;
  void open(String next) => setState(() => screen = next);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true, scaffoldBackgroundColor: canvas, colorScheme: ColorScheme.fromSeed(seedColor: accent)),
      home: Scaffold(
        body: SafeArea(child: screen == 'settings' ? SettingsScreen(open: open) : TasksScreen(open: open)),
      ),
    );
  }
}

/// Screens and regions are semantics containers that carry the anchor; their children stay separate nodes.
Widget anchor(String id, Widget child, {bool container = true}) => Semantics(identifier: id, container: container, explicitChildNodes: container, child: child);

class ScreenRoot extends StatelessWidget {
  const ScreenRoot({super.key, required this.id, required this.children});
  final String id;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => anchor(id, SizedBox.expand(
        child: Padding(padding: const EdgeInsets.fromLTRB(20, 16, 20, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children)),
      ));
}

class Header extends StatelessWidget {
  const Header({super.key, required this.prefix, required this.title, required this.action, required this.onAction});
  final String prefix, title, action;
  final VoidCallback onAction;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: anchor('$prefix.header', SizedBox(
          height: 44,
          child: Row(children: [
            anchor('$prefix.title', Text(title, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: ink)), container: false),
            const Spacer(),
            anchor(action == 'Back' ? '$prefix.back' : '$prefix.settings',
                Semantics(button: true, child: GestureDetector(onTap: onAction, child: Text(action, style: const TextStyle(fontSize: 17, color: accent)))), container: false),
          ]),
        )),
      );
}

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.id, required this.title, required this.onTap, this.wide = false});
  final String id, title;
  final VoidCallback onTap;
  final bool wide;
  @override
  Widget build(BuildContext context) => anchor(id, Semantics(
        button: true,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            height: 44,
            width: wide ? double.infinity : null,
            padding: const EdgeInsets.symmetric(horizontal: 20),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: accent, borderRadius: BorderRadius.circular(10)),
            child: Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: Colors.white)),
          ),
        ),
      ), container: false);
}

class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key, required this.open});
  final void Function(String) open;
  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  final items = ['Review prototype', 'Ship version'];
  final draft = TextEditingController();
  bool showError = false;

  void add() {
    FocusScope.of(context).unfocus();
    final text = draft.text.trim();
    setState(() {
      if (text.isEmpty) {
        showError = true;
      } else {
        showError = false;
        items.add(text);
        draft.clear();
      }
    });
  }

  @override
  Widget build(BuildContext context) => ScreenRoot(id: 'tasks', children: [
        Header(prefix: 'tasks', title: 'Today', action: 'Settings', onAction: () => widget.open('settings')),
        anchor('tasks.list', Column(children: [
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Container(
                height: 48,
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                alignment: Alignment.centerLeft,
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
                child: anchor('tasks.item', Text(item, style: const TextStyle(fontSize: 17, color: ink)), container: false),
              ),
            ),
        ])),
        const SizedBox(height: 8),
        anchor('tasks.form', Row(children: [
          Expanded(child: anchor('tasks.input', SizedBox(
            height: 44,
            child: TextField(
              controller: draft,
              style: const TextStyle(fontSize: 17, color: ink),
              decoration: InputDecoration(
                hintText: 'New task',
                hintStyle: const TextStyle(color: placeholder),
                filled: true,
                fillColor: Colors.white,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: border)),
                focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: accent)),
              ),
              onSubmitted: (_) => add(),
            ),
          ), container: false)),
          const SizedBox(width: 10),
          PrimaryButton(id: 'tasks.add', title: 'Add', onTap: add),
        ])),
        if (showError)
          Padding(padding: const EdgeInsets.only(top: 12), child: anchor('tasks.error', const Text('Enter a task first.', style: TextStyle(fontSize: 15, color: danger)), container: false)),
      ]);
}

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.open});
  final void Function(String) open;
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool notify = false, saved = false;
  @override
  Widget build(BuildContext context) => ScreenRoot(id: 'settings', children: [
        Header(prefix: 'settings', title: 'Settings', action: 'Back', onAction: () => widget.open('tasks')),
        anchor('settings.notify', Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
          child: Row(children: [
            const Text('Daily reminder', style: TextStyle(fontSize: 17, color: ink)),
            const Spacer(),
            anchor('settings.notify-toggle', Switch(value: notify, activeTrackColor: accent, onChanged: (value) => setState(() => notify = value)), container: false),
          ]),
        )),
        const SizedBox(height: 16),
        PrimaryButton(id: 'settings.save', title: 'Save', wide: true, onTap: () => setState(() => saved = true)),
        if (saved) Padding(padding: const EdgeInsets.only(top: 12), child: anchor('settings.saved', const Text('Saved.', style: TextStyle(fontSize: 15, color: accent)), container: false)),
      ]);
}

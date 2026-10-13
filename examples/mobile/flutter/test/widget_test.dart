// The app's own functional tests (ProtoFlow `functional` for the flutter target).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:protoflow_tasks/main.dart';

void main() {
  testWidgets('adding a task appends it and clears the field', (tester) async {
    await tester.pumpWidget(const TasksApp(initial: 'tasks'));
    await tester.enterText(find.byType(TextField), 'Write tests');
    await tester.tap(find.text('Add'));
    await tester.pump();
    expect(find.text('Write tests'), findsOneWidget);
    expect(find.text('Enter a task first.'), findsNothing);
  });

  testWidgets('adding an empty task shows the error', (tester) async {
    await tester.pumpWidget(const TasksApp(initial: 'tasks'));
    await tester.tap(find.text('Add'));
    await tester.pump();
    expect(find.text('Enter a task first.'), findsOneWidget);
  });

  testWidgets('settings can be saved and closed', (tester) async {
    await tester.pumpWidget(const TasksApp(initial: 'settings'));
    await tester.tap(find.byType(Switch));
    await tester.tap(find.text('Save'));
    await tester.pump();
    expect(find.text('Saved.'), findsOneWidget);
    await tester.tap(find.text('Back'));
    await tester.pump();
    expect(find.text('Today'), findsOneWidget);
  });
}

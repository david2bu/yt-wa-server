/**
 * Owner-only commands for your own needs. Add an object here and it shows up in !עזרה.
 *
 *   names:       what you type after "!" (first one is shown in the help)
 *   description: one line for !עזרה
 *   run(ctx, cmd, { reply, store, wa })
 *       ctx.jid  - the chat to answer in
 *       cmd.args - words after the command, cmd.rest - the whole text after it
 */
export const personalCommands = [
  {
    names: ['פינג', 'ping'],
    description: 'בדיקה שהבוט חי',
    run: (ctx, _cmd, { reply }) => reply(ctx.jid, '🏓 פונג'),
  },
]

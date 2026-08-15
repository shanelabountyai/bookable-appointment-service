// The D-3 bans (CLAUDE.md "The time rules"), shared by every eslint config in
// this repo. Every one of these is a silent axis-crossing through the process
// timezone — CalendarDay/WallTime (rules) must never touch Instant (occurrences)
// except inside the one conversion module built in A-002.
export const noAxisCrossingRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length>0]",
      message: 'new Date(string) crosses the calendar/instant axis through the process timezone. Use packages/core/time.',
    },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='parse']",
      message: 'Date.parse crosses the calendar/instant axis through the process timezone. Use packages/core/time.',
    },
    {
      selector: "CallExpression[callee.property.name=/^(get|set)(UTC)?(Hours|Minutes|Seconds|Milliseconds|Date|Month|FullYear|Day)$/]",
      message: 'Date get/set accessors read/write through the process timezone. Use packages/core/time.',
    },
    {
      selector: "CallExpression[callee.property.name='getTimezoneOffset']",
      message: 'getTimezoneOffset reads the process timezone directly. Use packages/core/time.',
    },
    {
      selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
      message: "toISOString().slice(0,10) derives a calendar day from an instant through the process timezone. Use packages/core/time.",
    },
  ],
};

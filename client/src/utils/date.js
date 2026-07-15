// Local-calendar-date helpers. Never use toISOString() for "today" — it
// converts to UTC and rolls the date over early for anyone west of UTC.
export function getLocalDateString(date = new Date()) {
  const year  = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day   = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

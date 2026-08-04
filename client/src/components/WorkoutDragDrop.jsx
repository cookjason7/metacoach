// Drag-and-drop primitives for moving a scheduled workout occurrence to another
// day on the client Calendar. Kept in their own module (rather than inline in
// Calendar.jsx) so the drag wiring can be mounted and driven on its own.
//
// The pill/day *visuals* stay in Calendar.jsx — these components only add the
// drag/drop behaviour around whatever children they're given.
import { MouseSensor, TouchSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'

// Long-press duration for picking up a pill on touch. 500ms is the same threshold
// the message long-press menus use (Messages.jsx / StaffInbox.jsx), so the gesture
// feels consistent across the app.
export const LONG_PRESS_MS = 500

// Desktop: 8px of pointer travel starts a drag, so a plain click still falls
// through to the pill's own onClick (open the log modal).
// Mobile: a 500ms hold starts a drag, so a tap still opens the modal and a swipe
// still scrolls the page.
export function useWorkoutDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: LONG_PRESS_MS, tolerance: 8 } }),
  )
}

// Droppable id ⇄ date helpers, so both sides agree on the encoding.
export const dayDropId = dateISO => `day:${dateISO}`
export const dropIdToDate = id => (String(id).startsWith('day:') ? String(id).slice(4) : null)

// One draggable workout occurrence, identified by (assignment, the date it is
// currently shown on).
//
// touch-action: none — Android's native pan/scroll gesture otherwise preempts
// dnd-kit's TouchSensor before its 500ms activation delay can fire, so the pill
// itself must block native panning entirely and let the delay constraint be
// the sole gesture arbiter. Scrolling between/around pills still works because
// this is scoped to the pill wrapper only, not the day cell or any ancestor.
export function DraggableWorkout({ assignmentId, dateISO, entry, children }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `w:${assignmentId}:${dateISO}`,
    data: { entry, dateISO, assignmentId },
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      aria-roledescription={attributes['aria-roledescription']}
      data-drag-date={dateISO}
      data-drag-assignment={assignmentId}
      onContextMenu={e => e.preventDefault()}
      style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
      className={`select-none ${isDragging ? 'opacity-30' : ''}`}
    >
      {children}
    </div>
  )
}

// A calendar day that a pill can be dropped on. Highlights only while a pill from
// a *different* day is hovering it.
export function DroppableDay({ dateISO, className = '', children }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: dayDropId(dateISO) })
  const from = active?.data?.current?.dateISO
  const armed = isOver && from && from !== dateISO
  return (
    <div
      ref={setNodeRef}
      data-day={dateISO}
      data-armed={armed ? 'true' : undefined}
      className={`${className} ${armed ? 'ring-2 ring-[#E8670A] ring-inset bg-orange-50' : ''}`}
    >
      {children}
    </div>
  )
}

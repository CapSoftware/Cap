# Stream D: Frontend UI Context

**Workstream:** React components for ticket creation and settings

**Dependencies:** Streams A, B, C (all backend work)

**Prerequisites:** All backend APIs working

---

## Key Files to Understand

### Video Share Page Structure
- `apps/web/app/s/[videoId]/page.tsx` - Server component, fetches data
- `apps/web/app/s/[videoId]/Share.tsx` - Client component, orchestrates UI
- `apps/web/app/s/[videoId]/_components/ShareHeader.tsx` - Header with actions
- `apps/web/app/s/[videoId]/_components/Sidebar.tsx` - Tabbed sidebar
- `apps/web/app/s/[videoId]/types.ts` - VideoData type definition

### Settings Page Structure
- `apps/web/app/(org)/dashboard/settings/account/page.tsx`
- `apps/web/app/(org)/dashboard/settings/organization/page.tsx`
- Pattern: page.tsx imports Settings component

### Component Library
- `@cap/ui` - Shared UI components (Button, etc.)
- Uses Tailwind CSS
- Framer Motion for animations

### Auth Hook
```typescript
import { useCurrentUser } from "@/app/Layout/AuthContext";
const user = useCurrentUser();
const isOwner = user?.id === data.owner.id;
```

### Toast Notifications
```typescript
import { toast } from "sonner";
toast.success("Message");
toast.error("Error message");
```

---

## Tasks in This Stream

1. **D1:** Create Integrations settings page
2. **D2:** Create CreateTicketButton component
3. **D3:** Create CreateTicketModal component
4. **D4:** Integrate button into ShareHeader
5. **D5:** Add Integrations tab to Sidebar

---

## File Structure to Create

```
apps/web/
├── app/(org)/dashboard/settings/integrations/
│   ├── page.tsx
│   └── IntegrationsSettings.tsx
├── app/s/[videoId]/_components/
│   ├── CreateTicketButton.tsx
│   ├── CreateTicketModal.tsx
│   └── tabs/Integrations.tsx
```

---

## ShareHeader Integration Point

Around line 257 in ShareHeader.tsx, find:
```tsx
{user !== null && (
  <div className="flex space-x-2">
    <div>
      <div className="flex gap-2 items-center">
```

Add CreateTicketButton here:
```tsx
{isOwner && (
  <CreateTicketButton
    videoId={data.id}
    videoName={data.name}
    transcriptionStatus={data.transcriptionStatus}
  />
)}
```

---

## Sidebar Tab Integration

In Sidebar.tsx:

1. Add to TabType:
```typescript
type TabType = "activity" | "transcript" | "summary" | "integrations" | "settings";
```

2. Add to tabs array:
```typescript
{
  id: "integrations",
  label: "Integrations",
  disabled: false,
},
```

3. Add case in renderTabContent:
```typescript
case "integrations":
  return <Integrations videoId={data.id} ... />;
```

---

## Modal Pattern

Use Framer Motion AnimatePresence:
```tsx
<AnimatePresence>
  {isOpen && (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 ..."
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal content */}
      </motion.div>
    </motion.div>
  )}
</AnimatePresence>
```

---

## Form State Pattern

```typescript
const [loading, setLoading] = useState(true);
const [submitting, setSubmitting] = useState(false);
const [title, setTitle] = useState("");
// ... more fields

useEffect(() => {
  if (isOpen) extractTicket();
}, [isOpen]);

const handleSubmit = async () => {
  setSubmitting(true);
  const result = await createNotionTicket(input);
  if (result.success) {
    toast.success("Created!");
    onClose();
  } else {
    toast.error(result.error);
  }
  setSubmitting(false);
};
```

---

## VideoData Type Update

Ensure `apps/web/app/s/[videoId]/types.ts` includes:
```typescript
transcriptionStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | null;
```

---

## Testing Checklist

1. Settings page loads
2. Connect Notion flow works
3. Database selection saves
4. Disconnect works
5. CreateTicketButton shows for owner only
6. Modal loads transcript and extracts fields
7. Form edits work
8. Submission creates Notion page
9. Success toast shows with link
10. Integrations tab shows in sidebar

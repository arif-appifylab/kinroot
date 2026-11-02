import {createFileRoute} from '@tanstack/react-router';
import {Bell, Plus} from 'lucide-react';
import {useState} from 'react';
import {toast} from 'sonner';

import {LogoMark} from '@/components/logo';
import {ThemeToggle} from '@/components/theme-toggle';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {confirm} from '@/components/ui/confirm';
import {Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Field, Input, NativeSelect, Switch} from '@/components/ui/form';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip} from '@/components/ui/menu';
import {Avatar, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/misc';

// TEMPORARY (migration phase 1): a check that Kinroot's design system runs on the template
// (Tailwind build, fonts, Radix drawers and menus, toasts under the CSP). Phase 3 replaces this
// file with Kinroot's dashboard.
export const Route = createFileRoute('/')({component: FoundationCheck});

function FoundationCheck() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex items-center gap-3">
          <LogoMark className="size-9" />
          <div className="flex-1 text-lg font-bold">Kinroot</div>
          <ThemeToggle />
        </div>
        <PageHeader
          title="Foundation check"
          description="Kinroot's design system on the Astro template. The real screens arrive in the next phases."
          actions={
            <Button onClick={() => setOpen(true)}>
              <Plus /> Open a drawer
            </Button>
          }
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Buttons and badges</CardTitle>
              <CardDescription>Variants from the Kinroot kit.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => toast.success('Saved')}>
                Toast
              </Button>
              <Button variant="destructive" onClick={async () => (await confirm({title: 'Delete this?', destructive: true})) && toast('Deleted')}>
                Confirm
              </Button>
              <Tooltip content="A tooltip">
                <Button variant="ghost" size="icon" aria-label="Notifications">
                  <Bell />
                </Button>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>Edit</DropdownMenuItem>
                  <DropdownMenuItem destructive>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Badge tone="green">Won</Badge>
              <Avatar name="Ada Lovelace" color="#0d9488" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Tabs</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="a">
                <TabsList>
                  <TabsTrigger value="a">Activity</TabsTrigger>
                  <TabsTrigger value="b">Notes</TabsTrigger>
                </TabsList>
                <TabsContent value="a" className="pt-3 text-sm text-muted-foreground">
                  Timeline goes here.
                </TabsContent>
                <TabsContent value="b" className="pt-3 text-sm text-muted-foreground">
                  Notes go here.
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New contact</DialogTitle>
            <DialogDescription>Every popup in Kinroot is a right-side drawer.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="First name">
              <Input placeholder="Ada" />
            </Field>
            <Field label="Lifecycle stage">
              <NativeSelect defaultValue="LEAD">
                <option value="LEAD">Lead</option>
                <option value="CUSTOMER">Customer</option>
              </NativeSelect>
            </Field>
            <Field label="Email opt-out">
              <Switch />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import {Check, Monitor, Moon, Sun} from 'lucide-react';

import {useTheme, type Theme} from '@/lib/theme';

import {Button} from './ui/button';
import {DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger} from './ui/menu';

const OPTIONS: {value: Theme; label: string; icon: typeof Sun}[] = [
  {value: 'light', label: 'Light', icon: Sun},
  {value: 'dark', label: 'Dark', icon: Moon},
  {value: 'system', label: 'System', icon: Monitor},
];

export function ThemeToggle({className}: {className?: string}) {
  const {theme, dark, setTheme} = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label="Change theme">
          {dark ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40">
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => setTheme(o.value)}>
            <o.icon /> {o.label}
            {theme === o.value && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

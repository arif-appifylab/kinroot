import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {type Job, type JobSummary, type JobType, JOB_TYPES} from '../../lib/types';
import {api, ApiError, read} from '../api';
import {manageJobsQuery} from '../queries';
import {ago} from '../shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  LoadMore,
  Menu,
  PageHeader,
  RadioCards,
  rules,
  StatusBadge,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const EMPTY_JOB = {
  title: '',
  company: '',
  location: '',
  type: 'full-time',
  remote: false,
  description: '',
  applyUrl: '',
};

/** The job form's rules: the SAME limits `src/server/routes/jobs.ts` enforces. */
const JOB_RULES = {
  title: [rules.required('Enter a title.'), rules.maxLength(120)],
  company: [rules.required('Enter the company.'), rules.maxLength(80)],
  location: [rules.required('Enter a location, or "Anywhere".'), rules.maxLength(80)],
  description: [
    rules.required('Describe the job.'),
    rules.minLength(20, 'Write at least 20 characters so applicants know what it is.'),
    rules.maxLength(10000),
  ],
  applyUrl: [
    rules.required('Add where to apply.'),
    rules.pattern(/^(https:\/\/|mailto:)\S+$/i, 'Use an https:// link or a mailto: address.'),
    rules.maxLength(500),
  ],
};

/** How each job type reads, in the form and in the table. */
const TYPE_INFO: Record<JobType, {label: string; description: string}> = {
  'full-time': {label: 'Full time', description: 'A permanent role on a full week.'},
  'part-time': {label: 'Part time', description: 'Fewer hours, on a regular schedule.'},
  contract: {label: 'Contract', description: 'A fixed term or one project.'},
  internship: {label: 'Internship', description: 'Training for students and new starters.'},
};
const typeLabel = (type: string) => TYPE_INFO[type as JobType]?.label ?? type;

const jobUrl = (job: JobSummary) => `/jobs/${encodeURIComponent(job.slug)}/`;

/** Holders of `site:job:manage`: post, edit, close and delete jobs (`/site-api/jobs`). */
export function Jobs() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const form = useForm(EMPTY_JOB, JOB_RULES);
  const jobs = useInfiniteQuery(manageJobsQuery);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['jobs']});

  const save = useMutation({
    mutationFn: (values: typeof EMPTY_JOB) =>
      editing === 'new'
        ? read<{job: Job}>(api.jobs.$post({json: values}))
        : read<{job: Job}>(api.jobs[':id'].$patch({param: {id: String(editing)}, json: values})),
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Job posted.' : 'Changes saved.');
      setEditing(null);
      form.reset();
      return refresh();
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const open = useMutation({
    mutationFn: (id: number) => read<{job: Job}>(api.jobs.manage[':id'].$get({param: {id: String(id)}})),
    onSuccess: ({job}, id) => {
      form.reset({
        title: job.title,
        company: job.company,
        location: job.location,
        type: job.type,
        remote: job.remote,
        description: job.description,
        applyUrl: job.applyUrl,
      });
      save.reset();
      setEditing(id);
    },
  });
  const setStatus = useMutation({
    mutationFn: ({id, status}: {id: number; status: string; title: string}) =>
      read(api.jobs[':id'].$patch({param: {id: String(id)}, json: {status}})),
    onSuccess: (_data, {status, title}) => {
      toast.success(status === 'open' ? `Reopened “${title}”.` : `Closed “${title}”.`);
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => read(api.jobs[':id'].$delete({param: {id: String(id)}})),
    onSuccess: refresh,
  });

  // Which ROW is busy: only that row shows it, and the row cannot be acted on twice.
  const busyKey =
    (open.isPending && open.variables) ||
    (setStatus.isPending && setStatus.variables?.id) ||
    (remove.isPending && remove.variables) ||
    null;
  const rows = jobs.data?.pages.flatMap(page => page.jobs);
  const rowError = open.error ?? setStatus.error;

  const startNew = () => {
    form.reset();
    save.reset();
    setEditing('new');
  };
  const closeDrawer = () => {
    if (save.isPending) return;
    setEditing(null);
    form.reset();
  };
  const askDelete = (job: JobSummary) =>
    void confirm({
      title: `Delete “${job.title}”?`,
      body: 'It comes off the jobs page at once. This can’t be undone; close it instead to keep it.',
      confirmLabel: 'Delete job',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(job.id),
    }).then(ok => ok && toast.success(`Deleted “${job.title}”.`));

  const columns: Column<JobSummary>[] = [
    {
      key: 'title',
      header: 'Job',
      cell: job => (
        <div className="jobs-title">
          <span className="cell-title">
            <a href={jobUrl(job)}>{job.title}</a>
          </span>
          <span className="cell-sub">
            {job.company} · {job.location}
          </span>
        </div>
      ),
    },
    {key: 'type', header: 'Type', width: 'shrink', cell: job => typeLabel(job.type)},
    {
      key: 'remote',
      header: 'Remote',
      width: 'shrink',
      hideOnMobile: true,
      cell: job => (job.remote ? <Badge tone="info" icon="globe">Remote</Badge> : <span className="muted">On site</span>),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: job => <StatusBadge tone={job.status === 'open' ? 'success' : 'neutral'}>{job.status === 'open' ? 'Open' : 'Closed'}</StatusBadge>,
    },
    {key: 'posted', header: 'Posted', width: 'shrink', hideOnMobile: true, cell: job => ago(job.createdAt)},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: job =>
        busyKey === job.id ? (
          <IconButton icon="more" label={`Working on “${job.title}”`} size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${job.title}”`}
            disabled={busyKey !== null || save.isPending}
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: () => open.mutate(job.id)},
              job.status === 'open'
                ? {label: 'Close', icon: 'ban', onSelect: () => setStatus.mutate({id: job.id, status: 'closed', title: job.title})}
                : {label: 'Reopen', icon: 'refresh', onSelect: () => setStatus.mutate({id: job.id, status: 'open', title: job.title})},
              {label: 'View on site', icon: 'external', onSelect: () => void window.open(jobUrl(job), '_blank', 'noopener')},
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(job)},
            ]}
          />
        ),
    },
  ];

  const isNew = editing === 'new';
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);

  return (
    <div className="app-page jobs-screen">
      <PageHeader
        title="Jobs"
        description={
          <>
            Listed on <a href="/jobs/">/jobs</a>. Stored in this site's database; only people allowed to manage jobs see this screen.
          </>
        }
        actions={
          <Button icon="plus" onClick={startNew} disabled={save.isPending}>
            Post a job
          </Button>
        }
      />

      {rowError && <ErrorNote error={rowError} />}

      <Card flush>
        <DataTable
          caption="Jobs"
          columns={columns}
          rows={rows}
          rowKey={job => job.id}
          loading={jobs.isPending}
          error={jobs.error}
          busyKey={busyKey}
          empty={
            <EmptyState
              icon="briefcase"
              title="No jobs yet"
              action={
                <Button variant="secondary" icon="plus" onClick={startNew}>
                  Post a job
                </Button>
              }>
              The jobs you post show on the website's jobs page, newest first.
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={jobs} />

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'Post a job' : 'Edit job'}
        description={isNew ? 'It shows on the jobs page as soon as you post it.' : 'Changes show on the jobs page at once.'}
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel={isNew ? 'Posting…' : 'Saving…'}>
              {isNew ? 'Post job' : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-title" label="Title" error={form.error('title')}>
            <input {...form.field('title')} autoComplete="off" />
          </Field>
          <div className="form-grid">
            <Field id="f-company" label="Company" error={form.error('company')}>
              <input {...form.field('company')} autoComplete="organization" />
            </Field>
            <Field id="f-location" label="Location" error={form.error('location')}>
              <input {...form.field('location')} />
            </Field>
          </div>
          <RadioCards
            legend="Job type"
            name="type"
            value={form.values.type as JobType}
            onChange={type => form.set('type', type)}
            options={JOB_TYPES.map(type => ({value: type, title: TYPE_INFO[type].label, description: TYPE_INFO[type].description}))}
          />
          <Checkbox
            label="Remote"
            description="People can do this job from anywhere."
            checked={Boolean(form.values.remote)}
            onChange={checked => form.set('remote', checked)}
          />
          <Field id="f-description" label="Description" hint="Leave a blank line between paragraphs." error={form.error('description')}>
            <textarea {...form.field('description')} rows={8} />
          </Field>
          <Field id="f-applyUrl" label="Apply link" hint="An https:// link or a mailto: address." error={form.error('applyUrl')}>
            <input {...form.field('applyUrl')} inputMode="url" placeholder="https://example.com/apply" />
          </Field>
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}

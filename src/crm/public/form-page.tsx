import {FormRenderer} from '@/components/forms/renderer';
import {PublicCard, PublicLayout} from '@/components/public-layout';
import type {Brand} from '@/lib/brand';
import type {PublicForm} from '@/lib/forms';
import {BrandProvider} from '@/lib/use-brand';

/**
 * A hosted form, /f/<slug> (src/pages/f/[slug].astro): Kinroot's renderer in its public frame. The
 * page loads the form on the server (a 404 or 503 there), so `form` is null only when it is missing.
 */
export default function FormPage({form, brand}: {form: PublicForm | null; brand: Brand}) {
  return (
    <BrandProvider brand={brand}>
      <PublicLayout>
        <PublicCard className={form ? 'max-w-2xl' : undefined}>
          {form ? (
            <FormRenderer form={form} />
          ) : (
            <div className="py-10 text-center">
              <h1 className="text-xl font-extrabold tracking-tight text-slate-900">Form not found</h1>
              <p className="mt-2 text-sm text-muted-foreground">The link may be wrong, or the form was removed.</p>
            </div>
          )}
        </PublicCard>
      </PublicLayout>
    </BrandProvider>
  );
}

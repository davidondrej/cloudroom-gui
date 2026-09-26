import { z } from "zod";

const UI_PREFERENCE_STRING_MAX_LENGTH = 1_024;
const UI_PREFERENCE_LIST_MAX_LENGTH = 10_000;
const THREAD_NAMING_RULES_MAX_LENGTH = 4_000;
export const DEFAULT_THREAD_NAMING_RULES =
  "Name the thread after the main thing the user wants to do. All lowercase, just 2-5 clear descriptive words.";

const sidebarOrganizationModeSchema = z.enum([
  "project",
  "chronological",
  "machine",
]);
export type SidebarOrganizationMode = z.infer<
  typeof sidebarOrganizationModeSchema
>;

const sidebarChronologicalSortSchema = z.enum([
  "updated",
  "created",
  "alpha",
  "none",
]);
export type SidebarChronologicalSort = z.infer<
  typeof sidebarChronologicalSortSchema
>;

const sidebarSectionSortSchema = z.object({
  sort: z.enum(["manual", "updated", "created", "alpha"]),
  direction: z.enum(["ascending", "descending"]),
});
export type SidebarSectionSort = z.infer<typeof sidebarSectionSortSchema>;

const collapsibleSidebarSectionIdSchema = z.enum(["pinned", "threads"]);

const uiPreferenceStringSchema = z
  .string()
  .min(1)
  .max(UI_PREFERENCE_STRING_MAX_LENGTH);
const uiPreferenceStringListSchema = z
  .array(uiPreferenceStringSchema)
  .max(UI_PREFERENCE_LIST_MAX_LENGTH);

export const UI_PREFERENCE_KEYS = [
  "sidebar.organizationMode",
  "sidebar.chronologicalSort",
  "sidebar.sortDirection",
  "sidebar.sectionSorts",
  "sidebar.sectionOrder",
  "sidebar.manualSectionOrder",
  "sidebar.machineSectionOrder",
  "sidebar.collapsedSections",
  "sidebar.collapsedProjects",
  "sidebar.collapsedThreads",
  "sidebar.collapsedEnvironments",
  "sidebar.collapsedThreadSections",
  "sidebar.collapsedMachines",
  "sidebar.footerOrder",
  "sidebar.hiddenFooterItems",
  "sidebar.pluginPanelOrder",
  "sidebar.visiblePluginPanels",
  "sidebar.navigationProvider",
  "sidebar.threadListProvider",
  "threadNaming.model",
  "threadNaming.fallbackModel",
  "threadNaming.rules",
] as const;
export type UiPreferenceKey = (typeof UI_PREFERENCE_KEYS)[number];
const uiPreferenceKeySchema = z.enum(UI_PREFERENCE_KEYS);

export function isUiPreferenceKey(value: string): value is UiPreferenceKey {
  return uiPreferenceKeySchema.safeParse(value).success;
}

interface UiPreferenceDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: Schema;
  defaultValue: z.infer<Schema>;
  description: string;
}

function defineUiPreference<Schema extends z.ZodTypeAny>(
  schema: Schema,
  defaultValue: z.infer<Schema>,
  description: string,
): UiPreferenceDefinition<Schema> {
  return { schema, defaultValue, description };
}

export const uiPreferenceDefinitions = {
  "sidebar.organizationMode": defineUiPreference(
    sidebarOrganizationModeSchema,
    "project",
    "How the sidebar groups threads: by project, Custom (chronological), or by machine. Defaults to By project when unset.",
  ),
  "sidebar.chronologicalSort": defineUiPreference(
    sidebarChronologicalSortSchema,
    "updated",
    "Sort order for the chronological sidebar organization.",
  ),
  "sidebar.sortDirection": defineUiPreference(
    z.enum(["default", "ascending", "descending"]),
    "default",
    "Sidebar thread sort direction; default preserves the selected field's original direction.",
  ),
  "sidebar.sectionSorts": defineUiPreference(
    z.record(uiPreferenceStringSchema, sidebarSectionSortSchema),
    {},
    "Sort per sidebar section id. Sections without an entry use sidebar.chronologicalSort. Pinned also allows manual drag order.",
  ),
  "sidebar.sectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "projects", "threads"],
    "Top-level section order when the sidebar is organized by project.",
  ),
  "sidebar.manualSectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "sections", "threads"],
    "Top-level section order when the sidebar is organized chronologically.",
  ),
  "sidebar.machineSectionOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    ["pinned", "machines", "threads"],
    "Top-level section order when the sidebar is organized by machine.",
  ),
  "sidebar.collapsedSections": defineUiPreference(
    z
      .array(collapsibleSidebarSectionIdSchema)
      .max(UI_PREFERENCE_LIST_MAX_LENGTH),
    [],
    "Built-in sidebar sections that are collapsed.",
  ),
  "sidebar.collapsedProjects": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Project ids whose sidebar rows are collapsed.",
  ),
  "sidebar.collapsedThreads": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Thread ids whose child threads are collapsed in the sidebar.",
  ),
  "sidebar.collapsedEnvironments": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Environment ids whose sidebar rows are collapsed.",
  ),
  "sidebar.collapsedThreadSections": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Thread section ids that are collapsed in the sidebar.",
  ),
  "sidebar.collapsedMachines": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Machine ids whose sidebar rows are collapsed.",
  ),
  "sidebar.footerOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Order of built-in and plugin sidebar footer actions.",
  ),
  "sidebar.hiddenFooterItems": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Sidebar footer actions moved into the More menu.",
  ),
  "sidebar.pluginPanelOrder": defineUiPreference(
    uiPreferenceStringListSchema,
    [],
    "Order of navigation entries in the sidebar navigation strip.",
  ),
  "sidebar.visiblePluginPanels": defineUiPreference(
    uiPreferenceStringListSchema.nullable(),
    null,
    "Navigation entries shown in the sidebar navigation strip; null shows every entry.",
  ),
  "sidebar.navigationProvider": defineUiPreference(
    uiPreferenceStringSchema,
    "__automatic__",
    "Plugin that renders the sidebar navigation, or __automatic__ / __builtin__.",
  ),
  "sidebar.threadListProvider": defineUiPreference(
    uiPreferenceStringSchema,
    "__automatic__",
    "Plugin that renders the sidebar thread list, or __automatic__ / __builtin__.",
  ),
  "threadNaming.model": defineUiPreference(
    uiPreferenceStringSchema.nullable(),
    null,
    "Model that names new threads after the first message, as provider/model; null uses the app's inference model.",
  ),
  "threadNaming.fallbackModel": defineUiPreference(
    uiPreferenceStringSchema.nullable(),
    null,
    "Model that names new threads when the naming model fails, as provider/model; null retries the naming model on timeouts.",
  ),
  "threadNaming.rules": defineUiPreference(
    z.string().trim().min(1).max(THREAD_NAMING_RULES_MAX_LENGTH),
    DEFAULT_THREAD_NAMING_RULES,
    "Rules and formatting the model follows when naming new threads.",
  ),
} as const satisfies Record<UiPreferenceKey, UiPreferenceDefinition>;

export type UiPreferenceValue<Key extends UiPreferenceKey> = z.infer<
  (typeof uiPreferenceDefinitions)[Key]["schema"]
>;
export type UiPreferenceValues = {
  [Key in UiPreferenceKey]: UiPreferenceValue<Key>;
};

export function getUiPreferenceDefault<Key extends UiPreferenceKey>(
  key: Key,
): UiPreferenceValue<Key> {
  return uiPreferenceDefinitions[key].defaultValue as UiPreferenceValue<Key>;
}

export const defaultUiPreferences: UiPreferenceValues = Object.fromEntries(
  UI_PREFERENCE_KEYS.map((key) => [key, getUiPreferenceDefault(key)]),
) as UiPreferenceValues;

export type UiPreferenceParseResult<Key extends UiPreferenceKey> =
  | { success: true; value: UiPreferenceValue<Key> }
  | { success: false; message: string };

export function parseUiPreferenceValue<Key extends UiPreferenceKey>(
  key: Key,
  value: unknown,
): UiPreferenceParseResult<Key> {
  const schema: z.ZodTypeAny = uiPreferenceDefinitions[key].schema;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { success: true, value: parsed.data as UiPreferenceValue<Key> };
  }
  return {
    success: false,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export function describeUiPreference(key: UiPreferenceKey): string {
  return uiPreferenceDefinitions[key].description;
}

export interface UiPreferenceEntry<
  Key extends UiPreferenceKey = UiPreferenceKey,
> {
  revision: number;
  value: UiPreferenceValue<Key>;
}

export type UiPreferenceEntries = {
  [Key in UiPreferenceKey]: UiPreferenceEntry<Key>;
};

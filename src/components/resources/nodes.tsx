import {
  Create,
  DataTable,
  DateField,
  Edit,
  List,
  SelectInput,
  Show,
  SimpleForm,
  SimpleShowLayout,
  TextField,
  TextInput,
} from '#/components/admin'
import { useRecordContext } from 'ra-core'

import { ProvisionButton } from '#/components/resources/provision-button'
import { NodeAccess } from '#/components/resources/node-access'
import {
  DEFAULT_TEMPLATE,
  TEMPLATE_CATALOG,
  templateMaintainedBy,
} from '#/lib/template-catalog'

/**
 * What a new project is cloned from.
 *
 * A pair rather than one setting: the repository carries the pages, the base
 * node carries the forms they post to. Read from the catalog, so a new combo
 * appears here without touching this file.
 */
const TEMPLATE_CHOICES = TEMPLATE_CATALOG.map((entry) => ({
  id: entry.key,
  name: entry.name,
}))

/**
 * Statuses a node moves through. Provisioning (step 3) advances these; until
 * then a node is just a record and stays `pending`.
 */
export const NODE_STATUSES = [
  { id: 'pending', name: 'Pending' },
  { id: 'provisioning', name: 'Provisioning' },
  { id: 'active', name: 'Active' },
  { id: 'suspended', name: 'Suspended' },
  { id: 'failed', name: 'Failed' },
]

export const NodeList = () => (
  <List sort={{ field: 'id', order: 'DESC' }}>
    <DataTable>
      <DataTable.Col source="slug" />
      <DataTable.Col source="name" />
      <DataTable.Col source="status" />
      <DataTable.Col source="hostname" />
      <DataTable.Col source="templateKey" label="Template" />
      <DataTable.Col source="createdAt">
        <DateField source="createdAt" showTime />
      </DataTable.Col>
    </DataTable>
  </List>
)

export const NodeCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="name" required />
      {/* Every Cloudflare resource this node owns is named by deriving it from
          the slug, and teardown deletes only by derived name — so it is fixed
          at creation and not editable afterwards. */}
      <TextInput
        source="slug"
        required
        helperText="Lowercase letters, numbers and dashes. Permanent once set."
      />
      <SelectInput
        source="templateKey"
        label="Template"
        choices={TEMPLATE_CHOICES}
        defaultValue={DEFAULT_TEMPLATE}
        helperText="Which repository and base node this project starts from."
      />
    </SimpleForm>
  </Create>
)

export const NodeEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="slug" disabled />
      <TextInput source="name" required />
      <TextInput source="hostname" />
      <SelectInput source="status" choices={NODE_STATUSES} />
    </SimpleForm>
  </Edit>
)

/**
 * A node that maintains a template is not a project.
 *
 * Its repository is the template itself, so editing it edits what every future
 * project starts from. That is deliberate, but it should never be a surprise —
 * least of all next to a Destroy button.
 */
const BaseNodeNotice = () => {
  const record = useRecordContext<{ slug?: string }>()
  const template = record?.slug ? templateMaintainedBy(record.slug) : undefined
  if (!template) return null

  return (
    <div className="border-primary/40 bg-primary/5 rounded-lg border p-3 text-sm">
      <p className="font-medium">Base node for “{template.name}”</p>
      <p className="text-muted-foreground">
        This node maintains the template rather than being a project. Its
        repository is <code className="font-mono">{template.repo}</code>, so
        what is edited here is what new projects are created from.
      </p>
    </div>
  )
}

export const NodeShow = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="slug" />
      <TextField source="name" />
      <TextField source="status" />
      <TextField source="hostname" />
      <TextField source="templateVersion" />
      <TextField source="templateKey" />
      <DateField source="createdAt" showTime />
      <BaseNodeNotice />
      <ProvisionButton />
      <NodeAccess />
      <ProvisionButton action="destroy" />
    </SimpleShowLayout>
  </Show>
)

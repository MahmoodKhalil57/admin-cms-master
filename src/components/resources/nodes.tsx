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

import { ProvisionButton } from '#/components/resources/provision-button'

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

export const NodeShow = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="slug" />
      <TextField source="name" />
      <TextField source="status" />
      <TextField source="hostname" />
      <TextField source="templateVersion" />
      <DateField source="createdAt" showTime />
      <ProvisionButton />
      <ProvisionButton action="destroy" />
    </SimpleShowLayout>
  </Show>
)

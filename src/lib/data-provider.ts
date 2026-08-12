import simpleRestProvider from 'ra-data-simple-rest'

/**
 * The admin talks to this app's own `/api/$resource` routes, which speak
 * ra-data-simple-rest's dialect (see `#/lib/rest`), so no custom provider is
 * needed here.
 */
export const dataProvider = simpleRestProvider('/api')

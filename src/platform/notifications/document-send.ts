import { BusinessRuleError } from '../errors/api-error';
import { registerMessages, translate } from '../i18n/messages';

registerMessages({
  'document_send.not_party': 'A document can only be sent to its own customer or supplier, at an address they hold.',
});

/** The channels a document may be sent by (the contract's `DocumentSendRequest.channels`), in the order asked. */
export type DocumentSendChannel = 'SMS' | 'WHATSAPP' | 'EMAIL';

/**
 * 422 RECIPIENT_NOT_DOCUMENT_PARTY (B11 continued 13, `sendBillingDocument`, `sendStatement`): the document has no party
 * (`DOCUMENT_HAS_NO_PARTY`, a walk-in receipt), or `recipient` names an address its own party does not hold
 * (`RECIPIENT_NOT_DOCUMENT_PARTY`). The message always goes to the party's own address, read when it is sent.
 */
export class RecipientNotDocumentPartyError extends BusinessRuleError {
  readonly code = 'RECIPIENT_NOT_DOCUMENT_PARTY';
  readonly messageKey = 'document_send.not_party';
  constructor(rule: 'RECIPIENT_NOT_DOCUMENT_PARTY' | 'DOCUMENT_HAS_NO_PARTY') {
    super(`the document cannot be sent: ${rule}`, [{ field: rule === 'DOCUMENT_HAS_NO_PARTY' ? null : '/recipient', code: rule, message: translate('document_send.not_party') }]);
  }
}

import { createParamDecorator } from '@nestjs/common';
import { currentActor, type Actor } from '../context/request-context';

/**
 * The actor the authentication guard bound to this request, or undefined on a public route. Handlers receive it and
 * pass it to the policy engine; they never trust an id from the body for who is acting.
 */
export const CurrentActor = createParamDecorator((): Actor | undefined => currentActor());

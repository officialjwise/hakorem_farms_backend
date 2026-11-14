import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { IamModule, ScopeNamesRegistry } from '../iam';
import { MdmScopeNames } from './infrastructure/scope-names';

/** MDM (layer 3). Answers IAM's ScopeNames port (ADR-0031). */
@Module({
  imports: [IamModule],
  providers: [MdmScopeNames],
})
export class MdmModule implements OnModuleInit {
  constructor(
    @Inject(ScopeNamesRegistry) private readonly scopeNames: ScopeNamesRegistry,
    @Inject(MdmScopeNames) private readonly implementation: MdmScopeNames,
  ) {}

  /** Registers MDM's implementation of IAM's ScopeNames port (MODULE_BOUNDARIES section 6, ADR-0031). */
  onModuleInit(): void {
    this.scopeNames.register(this.implementation);
  }
}

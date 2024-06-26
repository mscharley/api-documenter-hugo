// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import { FileSystem, NewlineKind, PackageName } from '@rushstack/node-core-library';
import {
	type DocBlock,
	DocCodeSpan,
	type DocComment,
	DocFencedCode,
	DocLinkTag,
	type DocNodeContainer,
	DocNodeKind,
	DocParagraph,
	DocPlainText,
	DocSection,
	StandardTags,
	StringBuilder,
	type TSDocConfiguration,
} from '@microsoft/tsdoc';
import {
	ApiAbstractMixin,
	ApiClass,
	ApiDeclaredItem,
	ApiDocumentedItem,
	type ApiEnum,
	type ApiEntryPoint,
	ApiInitializerMixin,
	ApiInterface,
	type ApiItem,
	ApiItemKind,
	type ApiModel,
	type ApiNamespace,
	ApiOptionalMixin,
	type ApiPackage,
	ApiParameterListMixin,
	ApiPropertyItem,
	ApiProtectedMixin,
	ApiReadonlyMixin,
	ApiReleaseTagMixin,
	ApiReturnTypeMixin,
	ApiStaticMixin,
	ApiTypeAlias,
	type Excerpt,
	type ExcerptToken,
	ExcerptTokenKind,
	type IFindApiItemsResult,
	type IResolveDeclarationReferenceResult,
	ReleaseTag,
} from '@microsoft/api-extractor-model';

import { CustomDocNodes } from '../nodes/CustomDocNodeKind.js';
import { DocHeading } from '../nodes/DocHeading.js';
import { DocTable } from '../nodes/DocTable.js';
import { DocEmphasisSpan } from '../nodes/DocEmphasisSpan.js';
import { DocTableRow } from '../nodes/DocTableRow.js';
import { DocTableCell } from '../nodes/DocTableCell.js';
import { DocNoteBox } from '../nodes/DocNoteBox.js';
import { Utilities } from '../utils/Utilities.js';
import { HugoMarkdownEmitter } from '../markdown/HugoMarkdownEmitter.js';
import { PluginLoader } from '../plugin/PluginLoader.js';
import {
	type IMarkdownDocumenterFeatureOnBeforeWritePageArgs,
	MarkdownDocumenterFeatureContext,
} from '../plugin/MarkdownDocumenterFeature.js';
import type { DocumenterConfig } from './DocumenterConfig.js';
import { MarkdownDocumenterAccessor } from '../plugin/MarkdownDocumenterAccessor.js';

export interface IMarkdownDocumenterOptions {
	apiModel: ApiModel;
	documenterConfig: DocumenterConfig | undefined;
	outputFolder: string;
}

/**
 * Renders API documentation in the Markdown file format.
 * For more info:  https://en.wikipedia.org/wiki/Markdown
 */
export class HugoDocumenter {
	private readonly _apiModel: ApiModel;
	private readonly _documenterConfig: DocumenterConfig | undefined;
	private readonly _tsdocConfiguration: TSDocConfiguration;
	private readonly _markdownEmitter: HugoMarkdownEmitter;
	private readonly _outputFolder: string;
	private readonly _pluginLoader: PluginLoader;
	// TODO: this is currently hardcoded, but useful for the docsy theme. This should be configurable
	private readonly _baseUrl: string = '/docs';

	public constructor(options: IMarkdownDocumenterOptions) {
		this._apiModel = options.apiModel;
		this._documenterConfig = options.documenterConfig;
		this._outputFolder = options.outputFolder;
		this._tsdocConfiguration = CustomDocNodes.configuration;
		this._markdownEmitter = new HugoMarkdownEmitter(this._apiModel);

		this._pluginLoader = new PluginLoader();
	}

	public generateFiles(): void {
		if (this._documenterConfig) {
			this._pluginLoader.load(this._documenterConfig, () => {
				return new MarkdownDocumenterFeatureContext({
					apiModel: this._apiModel,
					outputFolder: this._outputFolder,
					documenter: new MarkdownDocumenterAccessor({
						getLinkForApiItem: (apiItem: ApiItem) => {
							return this._getLinkFilenameForApiItem(apiItem);
						},
					}),
				});
			});
		}

		console.log();
		this._deleteOldOutputFiles();

		this._writeApiItemPage(this._apiModel);

		if (this._pluginLoader.markdownDocumenterFeature) {
			this._pluginLoader.markdownDocumenterFeature.onFinished({});
		}
	}

	private _writeApiItemPage(apiItem: ApiItem): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;
		const output: DocSection = new DocSection({ configuration });
		const frontMatter: Record<string, unknown> = {};

		const scopedName: string = apiItem.getScopedNameWithinPackage();

		switch (apiItem.kind) {
			case ApiItemKind.Class:
				frontMatter.title = `${scopedName} class`;
				break;
			case ApiItemKind.EntryPoint: {
				// TODO: Skip the root entrypoint as the package already writes this file
				if ((apiItem as ApiEntryPoint).importPath === '') {
					return;
				}
				const unscopedPackageName: string = PackageName.getUnscopedName((apiItem.parent as ApiPackage).displayName);
				frontMatter.title = `${unscopedPackageName}/${apiItem.displayName} entrypoint`;
				break;
			}
			case ApiItemKind.Enum:
				frontMatter.title = `${scopedName} enum`;
				break;
			case ApiItemKind.Interface:
				frontMatter.title = `${scopedName} interface`;
				break;
			case ApiItemKind.Constructor:
			case ApiItemKind.ConstructSignature:
				frontMatter.title = scopedName;
				break;
			case ApiItemKind.Method:
			case ApiItemKind.MethodSignature:
				frontMatter.title = `${scopedName} method`;
				break;
			case ApiItemKind.Function:
				frontMatter.title = `${scopedName} function`;
				break;
			case ApiItemKind.Model:
				frontMatter.title = 'API Reference';
				frontMatter.menu = { main: { weight: 20 } };
				break;
			case ApiItemKind.Namespace:
				frontMatter.title = `${scopedName} namespace`;
				break;
			case ApiItemKind.Package:
				console.log(`Writing ${apiItem.displayName} package`);
				const unscopedPackageName: string = PackageName.getUnscopedName(apiItem.displayName);
				frontMatter.title = `${unscopedPackageName} package`;
				break;
			case ApiItemKind.Property:
			case ApiItemKind.PropertySignature:
				frontMatter.title = `${scopedName} property`;
				break;
			case ApiItemKind.TypeAlias:
				frontMatter.title = `${scopedName} type`;
				break;
			case ApiItemKind.Variable:
				frontMatter.title = `${scopedName} variable`;
				break;
			default:
				throw new Error(`Unsupported API item kind: ${apiItem.kind}`);
		}

		if (ApiReleaseTagMixin.isBaseClassOf(apiItem)) {
			if (apiItem.releaseTag === ReleaseTag.Alpha) {
				this._writeAlphaWarning(output);
			} else if (apiItem.releaseTag === ReleaseTag.Beta) {
				this._writeBetaWarning(output);
			}
		}

		const decoratorBlocks: DocBlock[] = [];

		if (apiItem instanceof ApiDocumentedItem) {
			const tsdocComment: DocComment | undefined = apiItem.tsdocComment;

			if (tsdocComment) {
				decoratorBlocks.push(
					...tsdocComment.customBlocks.filter(
						(block) => block.blockTag.tagNameWithUpperCase === StandardTags.decorator.tagNameWithUpperCase,
					),
				);

				if (tsdocComment.deprecatedBlock) {
					output.appendNode(
						new DocNoteBox({ configuration }, [
							new DocParagraph({ configuration }, [
								new DocPlainText({
									configuration,
									text: 'Warning: This API is now obsolete. ',
								}),
							]),
							...tsdocComment.deprecatedBlock.content.nodes,
						]),
					);
				}

				this._appendSection(output, tsdocComment.summarySection);
			}
		}

		if (apiItem instanceof ApiDeclaredItem) {
			if (apiItem.excerpt.text.length > 0) {
				output.appendNode(
					new DocParagraph({ configuration }, [
						new DocEmphasisSpan({ configuration, bold: true }, [
							new DocPlainText({ configuration, text: 'Signature:' }),
						]),
					]),
				);
				output.appendNode(
					new DocFencedCode({
						configuration,
						code: apiItem.getExcerptWithModifiers(),
						language: 'typescript',
					}),
				);
			}

			this._writeHeritageTypes(output, apiItem);
		}

		if (decoratorBlocks.length > 0) {
			output.appendNode(
				new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [
						new DocPlainText({ configuration, text: 'Decorators:' }),
					]),
				]),
			);
			for (const decoratorBlock of decoratorBlocks) {
				output.appendNodes(decoratorBlock.content.nodes);
			}
		}

		let appendRemarks: boolean = true;
		switch (apiItem.kind) {
			case ApiItemKind.Class:
			case ApiItemKind.Interface:
			case ApiItemKind.Namespace:
			case ApiItemKind.Package:
				this._writeRemarksSection(output, apiItem);
				appendRemarks = false;
				break;
		}

		switch (apiItem.kind) {
			case ApiItemKind.Class:
				this._writeClassTables(output, apiItem as ApiClass);
				break;
			case ApiItemKind.Enum:
				this._writeEnumTables(output, apiItem as ApiEnum);
				break;
			case ApiItemKind.Interface:
				this._writeInterfaceTables(output, apiItem as ApiInterface);
				break;
			case ApiItemKind.Constructor:
			case ApiItemKind.ConstructSignature:
			case ApiItemKind.Method:
			case ApiItemKind.MethodSignature:
			case ApiItemKind.Function:
				this._writeParameterTables(output, apiItem as ApiParameterListMixin);
				this._writeThrowsSection(output, apiItem);
				break;
			case ApiItemKind.Namespace:
				this._writePackageOrNamespaceTables(output, apiItem as ApiNamespace);
				break;
			case ApiItemKind.Model:
				this._writeModelTable(output, apiItem as ApiModel);
				break;
			case ApiItemKind.EntryPoint:
				// TODO: Actually document entrypoints correctly
				output.appendNodeInParagraph(new DocPlainText({ configuration, text: 'TODO: Please reference the root entrypoint which contains links to elements from all entrypoints' }));
				break;
			case ApiItemKind.Package:
				this._writePackageOrNamespaceTables(output, apiItem as ApiPackage);
				break;
			case ApiItemKind.Property:
			case ApiItemKind.PropertySignature:
				break;
			case ApiItemKind.TypeAlias:
				break;
			case ApiItemKind.Variable:
				break;
			default:
				throw new Error(`Unsupported API item kind: ${apiItem.kind}`);
		}

		if (appendRemarks) {
			this._writeRemarksSection(output, apiItem);
		}

		const filename: string = path.join(this._outputFolder, this._getFilenameForApiItem(apiItem));
		const stringBuilder: StringBuilder = new StringBuilder();

		// stringBuilder.append('<!-- Do not edit this file. It is automatically generated by API Documenter. -->\n\n');

		this._markdownEmitter.emitWithFrontMatter(stringBuilder, output, frontMatter, {
			contextApiItem: apiItem,
			onGetFilenameForApiItem: (apiItemForFilename: ApiItem) => {
				return this._getLinkFilenameForApiItem(apiItemForFilename);
			},
		});

		let pageContent: string = stringBuilder.toString();

		if (this._pluginLoader.markdownDocumenterFeature) {
			// Allow the plugin to customize the pageContent
			const eventArgs: IMarkdownDocumenterFeatureOnBeforeWritePageArgs = {
				apiItem: apiItem,
				outputFilename: filename,
				pageContent: pageContent,
			};
			this._pluginLoader.markdownDocumenterFeature.onBeforeWritePage(eventArgs);
			pageContent = eventArgs.pageContent;
		}

		FileSystem.ensureFolder(path.dirname(filename));
		FileSystem.writeFile(filename, pageContent, {
			convertLineEndings: this._documenterConfig ? this._documenterConfig.newlineKind : NewlineKind.CrLf,
		});
	}

	private _writeHeritageTypes(output: DocSection, apiItem: ApiDeclaredItem): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		if (apiItem instanceof ApiClass) {
			if (apiItem.extendsType) {
				const extendsParagraph: DocParagraph = new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [new DocPlainText({ configuration, text: 'Extends: ' })]),
				]);
				this._appendExcerptWithHyperlinks(extendsParagraph, apiItem.extendsType.excerpt);
				output.appendNode(extendsParagraph);
			}
			if (apiItem.implementsTypes.length > 0) {
				const implementsParagraph: DocParagraph = new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [
						new DocPlainText({ configuration, text: 'Implements: ' }),
					]),
				]);
				let needsComma: boolean = false;
				for (const implementsType of apiItem.implementsTypes) {
					if (needsComma) {
						implementsParagraph.appendNode(new DocPlainText({ configuration, text: ', ' }));
					}
					this._appendExcerptWithHyperlinks(implementsParagraph, implementsType.excerpt);
					needsComma = true;
				}
				output.appendNode(implementsParagraph);
			}
		}

		if (apiItem instanceof ApiInterface) {
			if (apiItem.extendsTypes.length > 0) {
				const extendsParagraph: DocParagraph = new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [new DocPlainText({ configuration, text: 'Extends: ' })]),
				]);
				let needsComma: boolean = false;
				for (const extendsType of apiItem.extendsTypes) {
					if (needsComma) {
						extendsParagraph.appendNode(new DocPlainText({ configuration, text: ', ' }));
					}
					this._appendExcerptWithHyperlinks(extendsParagraph, extendsType.excerpt);
					needsComma = true;
				}
				output.appendNode(extendsParagraph);
			}
		}

		if (apiItem instanceof ApiTypeAlias) {
			const refs: ExcerptToken[] = apiItem.excerptTokens.filter(
				(token) =>
					token.kind === ExcerptTokenKind.Reference
					&& token.canonicalReference
					&& this._apiModel.resolveDeclarationReference(token.canonicalReference, undefined).resolvedApiItem,
			);
			if (refs.length > 0) {
				const referencesParagraph: DocParagraph = new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [
						new DocPlainText({ configuration, text: 'References: ' }),
					]),
				]);
				let needsComma: boolean = false;
				const visited: Set<string> = new Set();
				for (const ref of refs) {
					if (visited.has(ref.text)) {
						continue;
					}
					visited.add(ref.text);

					if (needsComma) {
						referencesParagraph.appendNode(new DocPlainText({ configuration, text: ', ' }));
					}

					this._appendExcerptTokenWithHyperlinks(referencesParagraph, ref);
					needsComma = true;
				}
				output.appendNode(referencesParagraph);
			}
		}
	}

	private _writeRemarksSection(output: DocSection, apiItem: ApiItem): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		if (apiItem instanceof ApiDocumentedItem) {
			const tsdocComment: DocComment | undefined = apiItem.tsdocComment;

			if (tsdocComment) {
				// Write the @remarks block
				if (tsdocComment.remarksBlock) {
					output.appendNode(new DocHeading({ configuration, title: 'Remarks' }));
					this._appendSection(output, tsdocComment.remarksBlock.content);
				}

				// Write the @example blocks
				const exampleBlocks: DocBlock[] = tsdocComment.customBlocks.filter(
					(x) => x.blockTag.tagNameWithUpperCase === StandardTags.example.tagNameWithUpperCase,
				);

				let exampleNumber: number = 1;
				for (const exampleBlock of exampleBlocks) {
					const heading: string = exampleBlocks.length > 1 ? `Example ${exampleNumber}` : 'Example';

					output.appendNode(new DocHeading({ configuration, title: heading }));

					this._appendSection(output, exampleBlock.content);

					++exampleNumber;
				}
			}
		}
	}

	private _writeThrowsSection(output: DocSection, apiItem: ApiItem): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		if (apiItem instanceof ApiDocumentedItem) {
			const tsdocComment: DocComment | undefined = apiItem.tsdocComment;

			if (tsdocComment) {
				// Write the @throws blocks
				const throwsBlocks: DocBlock[] = tsdocComment.customBlocks.filter(
					(x) => x.blockTag.tagNameWithUpperCase === StandardTags.throws.tagNameWithUpperCase,
				);

				if (throwsBlocks.length > 0) {
					const heading: string = 'Exceptions';
					output.appendNode(new DocHeading({ configuration, title: heading }));

					for (const throwsBlock of throwsBlocks) {
						this._appendSection(output, throwsBlock.content);
					}
				}
			}
		}
	}

	/**
	 * GENERATE PAGE: MODEL
	 */
	private _writeModelTable(output: DocSection, apiModel: ApiModel): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const packagesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Package', 'Description'],
		});

		for (const apiMember of apiModel.members) {
			const row: DocTableRow = new DocTableRow({ configuration }, [
				this._createTitleCell(apiMember),
				this._createDescriptionCell(apiMember),
			]);

			switch (apiMember.kind) {
				case ApiItemKind.Package:
					packagesTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;
			}
		}

		if (packagesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Packages' }));
			output.appendNode(packagesTable);
		}
	}

	/**
	 * GENERATE PAGE: PACKAGE or NAMESPACE
	 */
	private _writePackageOrNamespaceTables(output: DocSection, apiContainer: ApiPackage | ApiNamespace): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const abstractClassesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Abstract Class', 'Description'],
		});

		const classesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Class', 'Description'],
		});

		const enumerationsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Enumeration', 'Description'],
		});

		const functionsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Function', 'Description'],
		});

		const interfacesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Interface', 'Description'],
		});

		const namespacesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Namespace', 'Description'],
		});

		const variablesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Variable', 'Description'],
		});

		const typeAliasesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Type Alias', 'Description'],
		});

		if (apiContainer.kind === ApiItemKind.Package) {
			const entrypointsTable = new DocTable({
				configuration,
				headerTitles: ['Path'],
			});

			for (const entrypoint of (apiContainer as ApiPackage).entryPoints) {
				const path = new DocTableCell({ configuration }, [
					new DocParagraph({ configuration }, [
						new DocLinkTag({
							configuration,
							tagName: '@link',
							linkText: `${apiContainer.name}${entrypoint.importPath === '' ? '' : `/${entrypoint.importPath}`}`,
							urlDestination: this._getLinkFilenameForApiItem(entrypoint),
						}),
					]),
				]);
				entrypointsTable.addRow(new DocTableRow({ configuration }, [path]));
				this._writeApiItemPage(entrypoint);
			}

			// There will always be at least one entrypoint, but we only need a table if there is more than the root
			if (entrypointsTable.rows.length > 1) {
				output.appendNode(new DocHeading({ configuration, title: 'Entrypoints' }));
				output.appendNode(entrypointsTable);
			}
		}

		const apiMembers: ReadonlyArray<ApiItem>
			= apiContainer.kind === ApiItemKind.Package
				? (apiContainer as ApiPackage).entryPoints.flatMap((ep) => ep.members)
				: (apiContainer as ApiNamespace).members;

		for (const apiMember of apiMembers) {
			const row: DocTableRow = new DocTableRow({ configuration }, [
				this._createTitleCell(apiMember),
				this._createDescriptionCell(apiMember),
			]);

			switch (apiMember.kind) {
				case ApiItemKind.Class:
					if (ApiAbstractMixin.isBaseClassOf(apiMember) && apiMember.isAbstract) {
						abstractClassesTable.addRow(row);
					} else {
						classesTable.addRow(row);
					}
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.Enum:
					enumerationsTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.Interface:
					interfacesTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.Namespace:
					namespacesTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.Function:
					functionsTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.TypeAlias:
					typeAliasesTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;

				case ApiItemKind.Variable:
					variablesTable.addRow(row);
					this._writeApiItemPage(apiMember);
					break;
			}
		}

		if (classesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Classes' }));
			output.appendNode(classesTable);
		}

		if (abstractClassesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Abstract Classes' }));
			output.appendNode(abstractClassesTable);
		}

		if (enumerationsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Enumerations' }));
			output.appendNode(enumerationsTable);
		}
		if (functionsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Functions' }));
			output.appendNode(functionsTable);
		}

		if (interfacesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Interfaces' }));
			output.appendNode(interfacesTable);
		}

		if (namespacesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Namespaces' }));
			output.appendNode(namespacesTable);
		}

		if (variablesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Variables' }));
			output.appendNode(variablesTable);
		}

		if (typeAliasesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Type Aliases' }));
			output.appendNode(typeAliasesTable);
		}
	}

	/**
	 * GENERATE PAGE: CLASS
	 */
	private _writeClassTables(output: DocSection, apiClass: ApiClass): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const eventsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
		});

		const constructorsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Constructor', 'Modifiers', 'Description'],
		});

		const propertiesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
		});

		const methodsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Method', 'Modifiers', 'Description'],
		});

		const apiMembers: ReadonlyArray<ApiItem> = this._getMembersAndWriteIncompleteWarning(apiClass, output);
		for (const apiMember of apiMembers) {
			const isInherited: boolean = apiMember.parent !== apiClass;
			switch (apiMember.kind) {
				case ApiItemKind.Constructor: {
					constructorsTable.addRow(
						new DocTableRow({ configuration }, [
							this._createTitleCell(apiMember),
							this._createModifiersCell(apiMember),
							this._createDescriptionCell(apiMember, isInherited),
						]),
					);

					this._writeApiItemPage(apiMember);
					break;
				}
				case ApiItemKind.Method: {
					methodsTable.addRow(
						new DocTableRow({ configuration }, [
							this._createTitleCell(apiMember),
							this._createModifiersCell(apiMember),
							this._createDescriptionCell(apiMember, isInherited),
						]),
					);

					this._writeApiItemPage(apiMember);
					break;
				}
				case ApiItemKind.Property: {
					if ((apiMember as ApiPropertyItem).isEventProperty) {
						eventsTable.addRow(
							new DocTableRow({ configuration }, [
								this._createTitleCell(apiMember),
								this._createModifiersCell(apiMember),
								this._createPropertyTypeCell(apiMember),
								this._createDescriptionCell(apiMember, isInherited),
							]),
						);
					} else {
						propertiesTable.addRow(
							new DocTableRow({ configuration }, [
								this._createTitleCell(apiMember),
								this._createModifiersCell(apiMember),
								this._createPropertyTypeCell(apiMember),
								this._createDescriptionCell(apiMember, isInherited),
							]),
						);
					}

					this._writeApiItemPage(apiMember);
					break;
				}
			}
		}

		if (eventsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Events' }));
			output.appendNode(eventsTable);
		}

		if (constructorsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Constructors' }));
			output.appendNode(constructorsTable);
		}

		if (propertiesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Properties' }));
			output.appendNode(propertiesTable);
		}

		if (methodsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Methods' }));
			output.appendNode(methodsTable);
		}
	}

	/**
	 * GENERATE PAGE: ENUM
	 */
	private _writeEnumTables(output: DocSection, apiEnum: ApiEnum): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const enumMembersTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Member', 'Value', 'Description'],
		});

		for (const apiEnumMember of apiEnum.members) {
			enumMembersTable.addRow(
				new DocTableRow({ configuration }, [
					new DocTableCell({ configuration }, [
						new DocParagraph({ configuration }, [
							new DocPlainText({ configuration, text: Utilities.getConciseSignature(apiEnumMember) }),
						]),
					]),
					this._createInitializerCell(apiEnumMember),
					this._createDescriptionCell(apiEnumMember),
				]),
			);
		}

		if (enumMembersTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Enumeration Members' }));
			output.appendNode(enumMembersTable);
		}
	}

	/**
	 * GENERATE PAGE: INTERFACE
	 */
	private _writeInterfaceTables(output: DocSection, apiInterface: ApiInterface): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const eventsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
		});

		const propertiesTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Property', 'Modifiers', 'Type', 'Description'],
		});

		const methodsTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Method', 'Description'],
		});

		const apiMembers: ReadonlyArray<ApiItem> = this._getMembersAndWriteIncompleteWarning(apiInterface, output);
		for (const apiMember of apiMembers) {
			const isInherited: boolean = apiMember.parent !== apiInterface;
			switch (apiMember.kind) {
				case ApiItemKind.ConstructSignature:
				case ApiItemKind.MethodSignature: {
					methodsTable.addRow(
						new DocTableRow({ configuration }, [
							this._createTitleCell(apiMember),
							this._createDescriptionCell(apiMember, isInherited),
						]),
					);

					this._writeApiItemPage(apiMember);
					break;
				}
				case ApiItemKind.PropertySignature: {
					if ((apiMember as ApiPropertyItem).isEventProperty) {
						eventsTable.addRow(
							new DocTableRow({ configuration }, [
								this._createTitleCell(apiMember),
								this._createModifiersCell(apiMember),
								this._createPropertyTypeCell(apiMember),
								this._createDescriptionCell(apiMember, isInherited),
							]),
						);
					} else {
						propertiesTable.addRow(
							new DocTableRow({ configuration }, [
								this._createTitleCell(apiMember),
								this._createModifiersCell(apiMember),
								this._createPropertyTypeCell(apiMember),
								this._createDescriptionCell(apiMember, isInherited),
							]),
						);
					}

					this._writeApiItemPage(apiMember);
					break;
				}
			}
		}

		if (eventsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Events' }));
			output.appendNode(eventsTable);
		}

		if (propertiesTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Properties' }));
			output.appendNode(propertiesTable);
		}

		if (methodsTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Methods' }));
			output.appendNode(methodsTable);
		}
	}

	/**
	 * GENERATE PAGE: FUNCTION-LIKE
	 */
	private _writeParameterTables(output: DocSection, apiParameterListMixin: ApiParameterListMixin): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const parametersTable: DocTable = new DocTable({
			configuration,
			headerTitles: ['Parameter', 'Type', 'Description'],
		});
		for (const apiParameter of apiParameterListMixin.parameters) {
			const parameterDescription: DocSection = new DocSection({ configuration });

			if (apiParameter.isOptional) {
				parameterDescription.appendNodesInParagraph([
					new DocEmphasisSpan({ configuration, italic: true }, [
						new DocPlainText({ configuration, text: '(Optional)' }),
					]),
					new DocPlainText({ configuration, text: ' ' }),
				]);
			}

			if (apiParameter.tsdocParamBlock) {
				this._appendAndMergeSection(parameterDescription, apiParameter.tsdocParamBlock.content);
			}

			parametersTable.addRow(
				new DocTableRow({ configuration }, [
					new DocTableCell({ configuration }, [
						new DocParagraph({ configuration }, [new DocPlainText({ configuration, text: apiParameter.name })]),
					]),
					new DocTableCell({ configuration }, [this._createParagraphForTypeExcerpt(apiParameter.parameterTypeExcerpt)]),
					new DocTableCell({ configuration }, parameterDescription.nodes),
				]),
			);
		}

		if (parametersTable.rows.length > 0) {
			output.appendNode(new DocHeading({ configuration, title: 'Parameters' }));
			output.appendNode(parametersTable);
		}

		if (ApiReturnTypeMixin.isBaseClassOf(apiParameterListMixin)) {
			const returnTypeExcerpt: Excerpt = apiParameterListMixin.returnTypeExcerpt;
			output.appendNode(new DocParagraph({ configuration }));
			output.appendNode(
				new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, bold: true }, [new DocPlainText({ configuration, text: 'Returns:' })]),
				]),
			);

			output.appendNode(this._createParagraphForTypeExcerpt(returnTypeExcerpt));

			if (apiParameterListMixin instanceof ApiDocumentedItem) {
				if (apiParameterListMixin.tsdocComment?.returnsBlock) {
					this._appendSection(output, apiParameterListMixin.tsdocComment.returnsBlock.content);
				}
			}
		}
	}

	private _createParagraphForTypeExcerpt(excerpt: Excerpt): DocParagraph {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const paragraph: DocParagraph = new DocParagraph({ configuration });

		if (!excerpt.text.trim()) {
			paragraph.appendNode(new DocPlainText({ configuration, text: '(not declared)' }));
		} else {
			this._appendExcerptWithHyperlinks(paragraph, excerpt);
		}

		return paragraph;
	}

	private _appendExcerptWithHyperlinks(docNodeContainer: DocNodeContainer, excerpt: Excerpt): void {
		for (const token of excerpt.spannedTokens) {
			this._appendExcerptTokenWithHyperlinks(docNodeContainer, token);
		}
	}

	private _appendExcerptTokenWithHyperlinks(docNodeContainer: DocNodeContainer, token: ExcerptToken): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		// Markdown doesn't provide a standardized syntax for hyperlinks inside code spans, so we will render
		// the type expression as DocPlainText.  Instead of creating multiple DocParagraphs, we can simply
		// discard any newlines and let the renderer do normal word-wrapping.
		const unwrappedTokenText: string = token.text.replace(/[\r\n]+/g, ' ');

		// If it's hyperlinkable, then append a DocLinkTag
		if (token.kind === ExcerptTokenKind.Reference && token.canonicalReference) {
			const apiItemResult: IResolveDeclarationReferenceResult = this._apiModel.resolveDeclarationReference(
				token.canonicalReference,
				undefined,
			);

			if (apiItemResult.resolvedApiItem) {
				docNodeContainer.appendNode(
					new DocLinkTag({
						configuration,
						tagName: '@link',
						linkText: unwrappedTokenText,
						urlDestination: this._getLinkFilenameForApiItem(apiItemResult.resolvedApiItem),
					}),
				);
				return;
			}
		}

		// Otherwise append non-hyperlinked text
		docNodeContainer.appendNode(new DocPlainText({ configuration, text: unwrappedTokenText }));
	}

	private _createTitleCell(apiItem: ApiItem): DocTableCell {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		let linkText: string = Utilities.getConciseSignature(apiItem);
		if (ApiOptionalMixin.isBaseClassOf(apiItem) && apiItem.isOptional) {
			linkText += '?';
		}

		return new DocTableCell({ configuration }, [
			new DocParagraph({ configuration }, [
				new DocLinkTag({
					configuration,
					tagName: '@link',
					linkText: linkText,
					urlDestination: this._getLinkFilenameForApiItem(apiItem),
				}),
			]),
		]);
	}

	/**
	 * This generates a DocTableCell for an ApiItem including the summary section and "(BETA)" annotation.
	 *
	 * @remarks
	 * We mostly assume that the input is an ApiDocumentedItem, but it's easier to perform this as a runtime
	 * check than to have each caller perform a type cast.
	 */
	private _createDescriptionCell(apiItem: ApiItem, isInherited: boolean = false): DocTableCell {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const section: DocSection = new DocSection({ configuration });

		if (ApiReleaseTagMixin.isBaseClassOf(apiItem)) {
			if (apiItem.releaseTag === ReleaseTag.Alpha || apiItem.releaseTag === ReleaseTag.Beta) {
				section.appendNodesInParagraph([
					new DocEmphasisSpan({ configuration, bold: true, italic: true }, [
						new DocPlainText({
							configuration,
							text: `(${apiItem.releaseTag === ReleaseTag.Alpha ? 'ALPHA' : 'BETA'})`,
						}),
					]),
					new DocPlainText({ configuration, text: ' ' }),
				]);
			}
		}

		if (ApiOptionalMixin.isBaseClassOf(apiItem) && apiItem.isOptional) {
			section.appendNodesInParagraph([
				new DocEmphasisSpan({ configuration, italic: true }, [new DocPlainText({ configuration, text: '(Optional)' })]),
				new DocPlainText({ configuration, text: ' ' }),
			]);
		}

		if (apiItem instanceof ApiDocumentedItem) {
			if (apiItem.tsdocComment !== undefined) {
				this._appendAndMergeSection(section, apiItem.tsdocComment.summarySection);
			}
		}

		if (isInherited && apiItem.parent) {
			section.appendNode(
				new DocParagraph({ configuration }, [
					new DocPlainText({ configuration, text: '(Inherited from ' }),
					new DocLinkTag({
						configuration,
						tagName: '@link',
						linkText: apiItem.parent.displayName,
						urlDestination: this._getLinkFilenameForApiItem(apiItem.parent),
					}),
					new DocPlainText({ configuration, text: ')' }),
				]),
			);
		}

		return new DocTableCell({ configuration }, section.nodes);
	}

	private _createModifiersCell(apiItem: ApiItem): DocTableCell {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const section: DocSection = new DocSection({ configuration });

		// Output modifiers in syntactically correct order: first access modifier (here: `protected`), then
		// `static` or `abstract` (no member can be both, so the order between the two of them does not matter),
		// last `readonly`. If `override` was supported, it would go directly before `readonly`.

		if (ApiProtectedMixin.isBaseClassOf(apiItem)) {
			if (apiItem.isProtected) {
				section.appendNode(
					new DocParagraph({ configuration }, [new DocCodeSpan({ configuration, code: 'protected' })]),
				);
			}
		}

		if (ApiStaticMixin.isBaseClassOf(apiItem)) {
			if (apiItem.isStatic) {
				section.appendNode(new DocParagraph({ configuration }, [new DocCodeSpan({ configuration, code: 'static' })]));
			}
		}

		if (ApiAbstractMixin.isBaseClassOf(apiItem)) {
			if (apiItem.isAbstract) {
				section.appendNode(new DocParagraph({ configuration }, [new DocCodeSpan({ configuration, code: 'abstract' })]));
			}
		}

		if (ApiReadonlyMixin.isBaseClassOf(apiItem)) {
			if (apiItem.isReadonly) {
				section.appendNode(new DocParagraph({ configuration }, [new DocCodeSpan({ configuration, code: 'readonly' })]));
			}
		}

		return new DocTableCell({ configuration }, section.nodes);
	}

	private _createPropertyTypeCell(apiItem: ApiItem): DocTableCell {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const section: DocSection = new DocSection({ configuration });

		if (apiItem instanceof ApiPropertyItem) {
			section.appendNode(this._createParagraphForTypeExcerpt(apiItem.propertyTypeExcerpt));
		}

		return new DocTableCell({ configuration }, section.nodes);
	}

	private _createInitializerCell(apiItem: ApiItem): DocTableCell {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		const section: DocSection = new DocSection({ configuration });

		if (ApiInitializerMixin.isBaseClassOf(apiItem)) {
			if (apiItem.initializerExcerpt) {
				section.appendNodeInParagraph(new DocCodeSpan({ configuration, code: apiItem.initializerExcerpt.text }));
			}
		}

		return new DocTableCell({ configuration }, section.nodes);
	}

	private _writeBreadcrumb(output: DocSection, apiItem: ApiItem): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;

		output.appendNodeInParagraph(
			new DocLinkTag({
				configuration,
				tagName: '@link',
				linkText: 'Home',
				urlDestination: this._getLinkFilenameForApiItem(this._apiModel),
			}),
		);

		for (const hierarchyItem of apiItem.getHierarchy()) {
			switch (hierarchyItem.kind) {
				case ApiItemKind.Model:
				case ApiItemKind.EntryPoint:
					// We don't show the model as part of the breadcrumb because it is the root-level container.
					// We don't show the entry point because today API Extractor doesn't support multiple entry points;
					// this may change in the future.
					break;
				default:
					output.appendNodesInParagraph([
						new DocPlainText({
							configuration,
							text: ' > ',
						}),
						new DocLinkTag({
							configuration,
							tagName: '@link',
							linkText: hierarchyItem.displayName,
							urlDestination: this._getLinkFilenameForApiItem(hierarchyItem),
						}),
					]);
			}
		}
	}

	private _writeAlphaWarning(output: DocSection): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;
		const betaWarning: string
			= 'This API is provided as an alpha preview for developers and may change'
			+ ' based on feedback that we receive.  Do not use this API in a production environment.';
		output.appendNode(
			new DocNoteBox({ configuration }, [
				new DocParagraph({ configuration }, [new DocPlainText({ configuration, text: betaWarning })]),
			]),
		);
	}

	private _writeBetaWarning(output: DocSection): void {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;
		const betaWarning: string
			= 'This API is provided as a beta preview for developers and may change'
			+ ' based on feedback that we receive.  Do not use this API in a production environment.';
		output.appendNode(
			new DocNoteBox({ configuration }, [
				new DocParagraph({ configuration }, [new DocPlainText({ configuration, text: betaWarning })]),
			]),
		);
	}

	private _appendSection(output: DocSection, docSection: DocSection): void {
		for (const node of docSection.nodes) {
			output.appendNode(node);
		}
	}

	private _appendAndMergeSection(output: DocSection, docSection: DocSection): void {
		let firstNode: boolean = true;
		for (const node of docSection.nodes) {
			if (firstNode) {
				if (node.kind === DocNodeKind.Paragraph) {
					output.appendNodesInParagraph(node.getChildNodes());
					firstNode = false;
					continue;
				}
			}
			firstNode = false;

			output.appendNode(node);
		}
	}

	private _getMembersAndWriteIncompleteWarning(
		apiClassOrInterface: ApiClass | ApiInterface,
		output: DocSection,
	): ReadonlyArray<ApiItem> {
		const configuration: TSDocConfiguration = this._tsdocConfiguration;
		const showInheritedMembers: boolean = Boolean(this._documenterConfig?.configFile.showInheritedMembers);
		if (!showInheritedMembers) {
			return apiClassOrInterface.members;
		}

		const result: IFindApiItemsResult = apiClassOrInterface.findMembersWithInheritance();

		// If the result is potentially incomplete, write a short warning communicating this.
		if (result.maybeIncompleteResult) {
			output.appendNode(
				new DocParagraph({ configuration }, [
					new DocEmphasisSpan({ configuration, italic: true }, [
						new DocPlainText({
							configuration,
							text: '(Some inherited members may not be shown because they are not represented in the documentation.)',
						}),
					]),
				]),
			);
		}

		// Log the messages for diagnostic purposes.
		for (const message of result.messages) {
			console.log(`Diagnostic message for findMembersWithInheritance: ${message.text}`);
		}

		return result.items;
	}

	private _getFilenameForApiItem(apiItem: ApiItem): string {
		if (apiItem.kind === ApiItemKind.Model) {
			return '_index.md';
		}

		let baseName: string = '';
		for (const hierarchyItem of apiItem.getHierarchy()) {
			// For overloaded methods, add a suffix such as "MyClass.myMethod_2".
			let qualifiedName: string = Utilities.getSafeFilenameForName(hierarchyItem.displayName);
			if (ApiParameterListMixin.isBaseClassOf(hierarchyItem)) {
				if (hierarchyItem.overloadIndex > 1) {
					// Subtract one for compatibility with earlier releases of API Documenter.
					// (This will get revamped when we fix GitHub issue #1308)
					qualifiedName += `_${hierarchyItem.overloadIndex - 1}`;
				}
			}
			if (hierarchyItem.kind === ApiItemKind.Variable) {
				qualifiedName = `var_${qualifiedName}`;
			}

			switch (hierarchyItem.kind) {
				case ApiItemKind.Model:
				case ApiItemKind.EnumMember:
					break;
				case ApiItemKind.EntryPoint: {
					const entrypointName = (hierarchyItem as ApiEntryPoint).name;
					if (entrypointName.length > 0) {
						baseName += `/${Utilities.getSafeFilenameForName(PackageName.getUnscopedName(entrypointName))}`;
					} else {
						baseName += '/_root';
					}
					break;
				}
				case ApiItemKind.Package:
					baseName = Utilities.getSafeFilenameForName(PackageName.getUnscopedName(hierarchyItem.displayName));
					if (hierarchyItem === apiItem) {
						// If we're generating a link to the package, then we should refer to the default entrypoint instead.
						baseName += '/_root';
					}
					break;
				default:
					baseName += `/${qualifiedName}`;
			}
		}
		return `${baseName}/_index.md`;
	}

	private _getLinkFilenameForApiItem(apiItem: ApiItem): string {
		return `${this._baseUrl}/${this._getFilenameForApiItem(apiItem)}`;
	}

	private _deleteOldOutputFiles(): void {
		console.log(`Deleting old output from ${this._outputFolder}`);
		FileSystem.ensureEmptyFolder(this._outputFolder);
	}
}

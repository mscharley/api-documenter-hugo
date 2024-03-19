// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

interface IBaseYamlModel {
	uid: string;
	name: string;
	package?: string;
	summary?: string;
}

export type CommonYamlModel = IBaseYamlModel & {
	syntax?: ISyntax;
	fullName?: string;
	isPreview?: boolean;
	isDeprecated?: boolean;
	remarks?: string;
	example?: string[];
	customDeprecatedMessage?: string;
};

export type PackageYamlModel = CommonYamlModel & {
	classes?: string[];
	interfaces?: string[];
	enums?: string[];
	typeAliases?: string[];
	properties?: FunctionYamlModel[];
	type?: 'package' | 'module';
	functions?: FunctionYamlModel[];
};

export type FunctionYamlModel = CommonYamlModel;

export type TypeAliasYamlModel = CommonYamlModel & {
	syntax: string;
};

export type TypeYamlModel = CommonYamlModel & {
	constructors?: FunctionYamlModel[];
	properties?: FunctionYamlModel[];
	methods?: FunctionYamlModel[];
	events?: FunctionYamlModel[];
	type: 'class' | 'interface';
	extends?: IType | string;
};

export type EnumYamlModel = CommonYamlModel & {
	fields: FieldYamlModel[];
};

export type FieldYamlModel = IBaseYamlModel & {
	numericValue?: number;
	value?: string;
};

export interface ISyntax {
	parameters?: IYamlParameter[];
	content?: string;
	return?: IReturn;
}

export interface IYamlParameter {
	id: string;
	type: IType | string;
	description?: string;
}

interface IReturn {
	type: IType | string;
	description?: string;
}

export interface IType {
	typeName?: string;
	typeId?: number;
	reflectedType?: IReflectedType;
	genericType?: IGenericType;
	intersectionType?: IIntersectionType;
	unionType?: IUnionType;
	arrayType?: IType | string;
}

export interface IUnionType {
	types: Types;
}

export interface IIntersectionType {
	types: Types;
}

export interface IGenericType {
	outter: IType | string;
	inner: Types;
}

export interface IReflectedType {
	key: IType | string;
	value: IType | string;
}

export interface IException {
	type: string;
	description: string;
}

type Types = IType[] | string[];

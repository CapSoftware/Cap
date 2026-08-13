use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{
    DeriveInput, FnArg, GenericArgument, ItemFn, Pat, PathArguments, ReturnType, Type,
    parse_macro_input,
};

#[proc_macro_attribute]
pub fn command(_attribute: TokenStream, item: TokenStream) -> TokenStream {
    let function = parse_macro_input!(item as ItemFn);
    expand_command(function).into()
}

#[proc_macro_derive(Event)]
pub fn derive_event(item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as DeriveInput);
    let name = input.ident;
    let event_name = pascal_to_kebab(&name.to_string());

    quote! {
        impl ::cap_desktop_runtime::Event for #name {
            const NAME: &'static str = #event_name;
        }
    }
    .into()
}

fn expand_command(function: ItemFn) -> proc_macro2::TokenStream {
    let function_name = &function.sig.ident;
    let command_name = function_name.to_string();
    let handler_name = format_ident!("__cap_desktop_command_{function_name}");
    let mut setup = Vec::new();
    let mut arguments = Vec::new();

    for input in &function.sig.inputs {
        let FnArg::Typed(argument) = input else {
            return syn::Error::new_spanned(input, "desktop commands cannot have a receiver")
                .to_compile_error();
        };
        let Pat::Ident(pattern) = argument.pat.as_ref() else {
            return syn::Error::new_spanned(
                &argument.pat,
                "desktop command arguments must be identifiers",
            )
            .to_compile_error();
        };
        let variable = &pattern.ident;
        let type_name = last_type_name(&argument.ty);

        match type_name.as_deref() {
            Some("AppHandle") => {
                setup.push(quote! { let #variable = context.app().clone(); });
                arguments.push(quote! { #variable });
            }
            Some("Window") | Some("WebviewWindow") => {
                setup.push(quote! { let #variable = context.window(); });
                arguments.push(quote! { #variable });
            }
            Some("State") | Some("MutableState") => {
                let Some(inner) = first_type_argument(&argument.ty) else {
                    return syn::Error::new_spanned(
                        &argument.ty,
                        "state arguments must include their managed type",
                    )
                    .to_compile_error();
                };
                if type_name.as_deref() == Some("MutableState") {
                    setup.push(quote! {
                        let #variable = context
                            .app()
                            .state::<::std::sync::Arc<::tokio::sync::RwLock<#inner>>>();
                    });
                } else {
                    setup.push(quote! { let #variable = context.app().state::<#inner>(); });
                }
                arguments.push(quote! { #variable });
            }
            Some("Channel") => {
                let Some(inner) = first_type_argument(&argument.ty) else {
                    return syn::Error::new_spanned(
                        &argument.ty,
                        "channel arguments must include their message type",
                    )
                    .to_compile_error();
                };
                let key = snake_to_camel(&variable.to_string());
                setup.push(quote! {
                    let #variable = ::cap_desktop_runtime::Channel::<#inner>::from_value(
                        context.channel_sender(),
                        ::cap_desktop_runtime::take_argument(&mut arguments, #key)?,
                        context.window_label(),
                    )?;
                });
                arguments.push(quote! { #variable });
            }
            Some(
                "WindowEditorInstance"
                | "OptionalWindowEditorInstance"
                | "WindowScreenshotEditorInstance",
            ) => {
                let ty = &argument.ty;
                setup.push(quote! {
                    let #variable = <#ty as ::cap_desktop_runtime::CommandArg>::from_command(&context)?;
                });
                arguments.push(quote! { #variable });
            }
            _ => {
                let key = snake_to_camel(&variable.to_string());
                if let Type::Reference(reference) = argument.ty.as_ref() {
                    let inner = reference.elem.as_ref();
                    if last_type_name(inner).as_deref() == Some("str") {
                        setup.push(quote! {
                            let #variable: ::std::string::String = ::cap_desktop_runtime::deserialize_argument(
                                ::cap_desktop_runtime::take_argument(&mut arguments, #key)?,
                                #key,
                            )?;
                        });
                        arguments.push(quote! { #variable.as_str() });
                    } else {
                        setup.push(quote! {
                            let #variable: #inner = ::cap_desktop_runtime::deserialize_argument(
                                ::cap_desktop_runtime::take_argument(&mut arguments, #key)?,
                                #key,
                            )?;
                        });
                        arguments.push(quote! { &#variable });
                    }
                } else {
                    let ty = &argument.ty;
                    setup.push(quote! {
                        let #variable: #ty = ::cap_desktop_runtime::deserialize_argument(
                            ::cap_desktop_runtime::take_argument(&mut arguments, #key)?,
                            #key,
                        )?;
                    });
                    arguments.push(quote! { #variable });
                }
            }
        }
    }

    let call = quote! { #function_name(#(#arguments),*) };
    let call = if function.sig.asyncness.is_some() {
        quote! { #call.await }
    } else {
        call
    };
    let serialize = match &function.sig.output {
        ReturnType::Type(_, ty) if is_result_type(ty) => quote! {
            let value = #call.map_err(|error| format!("{error:?}"))?;
            ::cap_desktop_runtime::serialize_command_result(value)
        },
        _ => quote! {
            let value = #call;
            ::cap_desktop_runtime::serialize_command_result(value)
        },
    };

    quote! {
        #function

        fn #handler_name(
            context: ::cap_desktop_runtime::CommandContext,
            arguments: ::serde_json::Value,
        ) -> ::cap_desktop_runtime::CommandFuture {
            Box::pin(async move {
                let mut arguments = ::cap_desktop_runtime::argument_object(arguments)?;
                #(#setup)*
                #serialize
            })
        }

        ::cap_desktop_runtime::inventory::submit! {
            ::cap_desktop_runtime::CommandRegistration {
                name: #command_name,
                handler: #handler_name,
            }
        }
    }
}

fn last_type_name(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(path) => path
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string()),
        Type::Reference(reference) => last_type_name(&reference.elem),
        _ => None,
    }
}

fn first_type_argument(ty: &Type) -> Option<Type> {
    let Type::Path(path) = ty else {
        return None;
    };
    let segment = path.path.segments.last()?;
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return None;
    };
    arguments.args.iter().find_map(|argument| match argument {
        GenericArgument::Type(ty) => Some(ty.clone()),
        _ => None,
    })
}

fn is_result_type(ty: &Type) -> bool {
    last_type_name(ty).as_deref() == Some("Result")
}

fn snake_to_camel(value: &str) -> String {
    let mut output = String::new();
    let mut uppercase = false;
    for character in value.trim_start_matches('_').chars() {
        if character == '_' {
            uppercase = true;
        } else if uppercase {
            output.extend(character.to_uppercase());
            uppercase = false;
        } else {
            output.push(character);
        }
    }
    output
}

fn pascal_to_kebab(value: &str) -> String {
    let mut output = String::new();
    for (index, character) in value.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            output.push('-');
        }
        output.extend(character.to_lowercase());
    }
    output
}

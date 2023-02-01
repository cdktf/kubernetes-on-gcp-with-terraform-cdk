#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0


set -ex

cd infrastructure
cdktf destroy --auto-approve infrastructure

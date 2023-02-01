#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0


set -ex

cd infrastructure
cdktf apply --auto-approve infrastructure
cdktf apply --auto-approve baseline
cdktf apply --auto-approve development
cdktf apply --auto-approve staging
cdktf apply --auto-approve production
